/**
 * Ralph autonomous loop: pure workspace-scoped loop logic
 * Zones: pi agent, orchestration, shared utils
 * Owns the marker protocol, per-iteration prompts, loop-state persistence, and
 * the pure decide step for the parent-side Ralph controller. Children run with
 * --no-extensions, so the child reports back through a trailing text marker
 * line instead of a tool call:
 *   RALPH-ARM: {"kickoff":"...","exit_condition":"...","guardrails":"..."}
 *   RALPH: continue | note=<short summary>
 *   RALPH: done | note=<reason>
 * The parent parses the marker on agent_end and performs the fresh-session
 * handoff over the existing RPC backend (newSession + rename + prompt).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Hard ceiling so a misjudged exit condition can never loop forever. */
export const RALPH_MAX_ITERATIONS = 500;

/** Fallback base name when the armed workspace has no session name. */
export const RALPH_DEFAULT_BASE_NAME = "ralph";

export interface RalphWorkspaceState {
  active: boolean;
  baseName: string;
  kickoff: string;
  exitCondition: string;
  guardrails: string;
  loop: number;
  maxIterations: number;
  startedAt: number;
  lastNote?: string;
  chatId?: number;
  messageThreadId?: number;
  replyToMessageId?: number;
  expectedTurnId?: string;
}

export interface RalphWorkspacesFileState {
  version: 1;
  workspaces: Record<string, RalphWorkspaceState>;
}

export function getTelegramRalphStatePath(agentDir: string): string {
  return join(agentDir, "telegram-ralph-state.json");
}

export interface RalphStateStore {
  read(workspaceName: string): RalphWorkspaceState | undefined;
  write(workspaceName: string, state: RalphWorkspaceState): void;
  clear(workspaceName: string): void;
}

/** Filesystem-backed JSON store keyed by workspace name. */
export function createRalphStateStore(path: string): RalphStateStore {
  const readFile = (): RalphWorkspacesFileState => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return { version: 1, workspaces: {} };
    }
    try {
      const parsed = JSON.parse(raw) as RalphWorkspacesFileState;
      if (!parsed || typeof parsed !== "object" || typeof parsed.workspaces !== "object" || parsed.workspaces === null) {
        return { version: 1, workspaces: {} };
      }
      return { version: 1, workspaces: parsed.workspaces };
    } catch {
      return { version: 1, workspaces: {} };
    }
  };
  const writeFile = (state: RalphWorkspacesFileState): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  };
  return {
    read(workspaceName) {
      return readFile().workspaces[workspaceName];
    },
    write(workspaceName, state) {
      const file = readFile();
      file.workspaces[workspaceName] = state;
      writeFile(file);
    },
    clear(workspaceName) {
      const file = readFile();
      if (!(workspaceName in file.workspaces)) return;
      delete file.workspaces[workspaceName];
      writeFile(file);
    },
  };
}

export interface RalphArmSpec {
  kickoff: string;
  exitCondition: string;
  guardrails: string;
}

export type RalphMarker =
  | { kind: "arm"; spec: RalphArmSpec }
  | { kind: "arm-invalid"; error: string }
  | { kind: "next"; done: boolean; note?: string };

const RALPH_ARM_MARKER_PATTERN = /^RALPH-ARM:\s*(\{.*\})\s*$/m;
const RALPH_NEXT_MARKER_PATTERN = /^RALPH:\s*(done|continue)\s*(?:\|\s*note=(.*?))?\s*$/im;

/**
 * Parse the trailing Ralph marker from a child's final assistant text. The arm
 * marker wins over a next marker if both somehow appear; a malformed arm JSON
 * is surfaced as arm-invalid so the controller can tell the operator instead
 * of silently ignoring a confirmed spec.
 */
export function parseRalphMarker(text: string): RalphMarker | undefined {
  const armMatch = RALPH_ARM_MARKER_PATTERN.exec(text);
  if (armMatch) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(armMatch[1]);
    } catch {
      return { kind: "arm-invalid", error: "RALPH-ARM marker has malformed JSON" };
    }
    const raw = parsed as Record<string, unknown>;
    const kickoff = typeof raw.kickoff === "string" ? raw.kickoff.trim() : "";
    const exitCondition =
      typeof raw.exit_condition === "string" ? raw.exit_condition.trim() : "";
    const guardrails =
      typeof raw.guardrails === "string" ? raw.guardrails.trim() : "";
    if (!kickoff) {
      return { kind: "arm-invalid", error: "RALPH-ARM marker is missing kickoff" };
    }
    if (!exitCondition) {
      return {
        kind: "arm-invalid",
        error: "RALPH-ARM marker is missing exit_condition",
      };
    }
    return { kind: "arm", spec: { kickoff, exitCondition, guardrails } };
  }
  const nextMatch = RALPH_NEXT_MARKER_PATTERN.exec(text);
  if (nextMatch) {
    const note = nextMatch[2]?.trim();
    return {
      kind: "next",
      done: nextMatch[1].toLowerCase() === "done",
      note: note ? note : undefined,
    };
  }
  return undefined;
}

/**
 * Strip any trailing `#loopN` segments from a session name so the loop base
 * never compounds when Ralph is re-armed in a topic whose current session name
 * is still a prior run's `base#loopN`. Repeated suffixes are all removed
 * (e.g. `task#loop2#loop1` -> `task`).
 */
export function stripRalphLoopSuffix(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/(?:#loop\d+)+$/, "").trim();
}

/** Compute the session display name for a given completed-iteration count. */
export function ralphSessionName(baseName: string, loop: number): string {
  const base = stripRalphLoopSuffix(baseName) || RALPH_DEFAULT_BASE_NAME;
  if (loop <= 0) return base;
  return `${base}#loop${loop}`;
}

/**
 * The arm-dialogue prompt sent to the topic child when the operator runs
 * /ralph. The child (clean of any Ralph machinery) negotiates the spec with
 * the operator in the topic and emits the RALPH-ARM marker only after explicit
 * confirmation.
 */
/**
 * Capability reminder injected into both the arm-dialogue and per-iteration
 * prompts. The child runs with --no-extensions, which only removes TypeScript
 * extension TOOLS — it does NOT remove skills. Skills are just SKILL.md + bash
 * scripts, so any agent with bash can use them. Spell this out so the child
 * (and the spec it negotiates) reaches for real capabilities (a headless
 * browser, HQ notes, pdf, etc.) instead of falling back to raw curl.
 */
export const RALPH_CAPABILITY_NOTE = [
  "Capabilities: you run with --no-extensions, which only removes extension TOOLS, NOT skills. You still have bash, so you can use ANY skill by reading its SKILL.md and running its scripts. Skills live in ~/.pi/agent/skills/<name>/SKILL.md. Notably:",
  "- browser (~/.pi/agent/skills/browser/SKILL.md): a real headless Chrome via CDP at pi-chrome:9222. Run python3 ~/.pi/agent/skills/browser/scripts/*.py (nav.py open, simphtml.py extract readable text, screenshot.py, eval.py run JS, lists.py links). Prefer this over curl for JS-rendered pages, Cloudflare/login walls, or anything a plain GET can't fetch.",
  "- eddie-hq-notes (~/.pi/agent/skills/eddie-hq-notes/SKILL.md): read/create/edit HQ vault notes via ehq-*.sh.",
  "- others as relevant: pdf, svg, youtube-video-processor, tg-user, etc. (browse ~/.pi/agent/skills/).",
  "Use curl only for simple static pages or JSON APIs; reach for the browser skill when the page needs rendering or is blocked.",
].join("\n");

export function buildRalphArmDialoguePrompt(initialTask: string): string {
  const lines = [
    "[ralph] The operator wants to set up an autonomous Ralph loop in this topic.",
    "",
    "A Ralph loop runs one task repeatedly; every iteration starts in a brand-new session with a clean context window, so the task spec must be self-contained.",
    "",
    RALPH_CAPABILITY_NOTE,
    "",
    "When negotiating the spec, fold the right capabilities into the kickoff (e.g. tell future iterations to use the browser skill for web research) so each fresh-context iteration knows how to do the work.",
    "",
    "Work with the operator to agree on:",
    "1. kickoff — the single task to perform each iteration (self-contained; assume no memory of prior iterations beyond a short note).",
    "2. exit_condition — an explicit, CHECKABLE condition that stops the loop. Refuse vague or open-ended exit conditions.",
    "3. guardrails — optional constraints that must always hold.",
  ];
  if (initialTask) {
    lines.push("", "The operator's initial description:", initialTask);
  }
  lines.push(
    "",
    "Discuss and refine until the operator explicitly confirms the spec. Only AFTER the operator confirms, end your reply with exactly one line (no formatting around it):",
    'RALPH-ARM: {"kickoff":"...","exit_condition":"...","guardrails":"..."}',
    "",
    "Do not output the RALPH-ARM line before the operator confirms. The loop starts immediately once you emit it.",
  );
  return lines.join("\n");
}

/**
 * The full per-iteration instruction handed to each fresh child session. It
 * restates the spec plus the marker protocol so a clean-context agent knows
 * exactly what to do and how to report back without any Ralph tooling.
 */
export function buildRalphIterationPrompt(state: RalphWorkspaceState): string {
  const iteration = state.loop + 1;
  const lines = [
    `[ralph loop] Autonomous iteration #${iteration} (fresh context).`,
    "",
    "Per-iteration task:",
    state.kickoff,
    "",
    "Exit condition (stop the loop when this is met):",
    state.exitCondition,
  ];
  if (state.guardrails) {
    lines.push("", "Guardrails (must always hold):", state.guardrails);
  }
  lines.push("", RALPH_CAPABILITY_NOTE);
  if (state.lastNote) {
    lines.push("", "Note from previous iteration:", state.lastNote);
  }
  lines.push(
    "",
    "Protocol:",
    "1. Do exactly ONE unit of work for this iteration.",
    "2. Evaluate the exit condition against the new state.",
    "3. End your final reply with exactly one marker line (own line, no formatting):",
    "   RALPH: done | note=<why the exit condition is met>",
    "   or",
    "   RALPH: continue | note=<short summary carried into the next iteration>",
    "Emit exactly one RALPH marker line. Do not start the next iteration yourself; the controller handles the handoff.",
  );
  return lines.join("\n");
}

export interface RalphArmDeps {
  spec: RalphArmSpec;
  baseName: string | undefined;
  now: number;
  maxIterations?: number;
  chatId?: number;
  messageThreadId?: number;
  replyToMessageId?: number;
}

/** Build the initial persisted loop state from a confirmed arm spec. */
export function buildRalphWorkspaceState(deps: RalphArmDeps): RalphWorkspaceState {
  return {
    active: true,
    baseName: stripRalphLoopSuffix(deps.baseName) || RALPH_DEFAULT_BASE_NAME,
    kickoff: deps.spec.kickoff,
    exitCondition: deps.spec.exitCondition,
    guardrails: deps.spec.guardrails,
    loop: 0,
    maxIterations: deps.maxIterations ?? RALPH_MAX_ITERATIONS,
    startedAt: deps.now,
    lastNote: undefined,
    chatId: deps.chatId,
    messageThreadId: deps.messageThreadId,
    replyToMessageId: deps.replyToMessageId,
  };
}

export type RalphNextDecision =
  | { kind: "done"; iterations: number; reason: "exit_condition" | "max_iterations" }
  | { kind: "continue"; state: RalphWorkspaceState; nextName: string };

/**
 * Pure decide step for a reported iteration result. On continue the returned
 * state has loop advanced and the note stored; the caller persists it.
 */
export function decideRalphNext(
  state: RalphWorkspaceState,
  input: { done: boolean; note?: string },
): RalphNextDecision {
  if (input.done) {
    return { kind: "done", iterations: state.loop + 1, reason: "exit_condition" };
  }
  const nextLoop = state.loop + 1;
  if (nextLoop >= state.maxIterations) {
    return { kind: "done", iterations: nextLoop, reason: "max_iterations" };
  }
  const advanced: RalphWorkspaceState = {
    ...state,
    loop: nextLoop,
    lastNote: input.note,
  };
  return {
    kind: "continue",
    state: advanced,
    nextName: ralphSessionName(advanced.baseName, nextLoop),
  };
}

export type RalphCommandRequest =
  | { kind: "arm-dialogue"; initialTask: string }
  | { kind: "status" }
  | { kind: "stop" };

/** Parse the /ralph command arguments. */
export function parseRalphCommand(args: string): RalphCommandRequest {
  const trimmed = args.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered === "status") return { kind: "status" };
  if (lowered === "stop") return { kind: "stop" };
  return { kind: "arm-dialogue", initialTask: trimmed };
}

/** Human-readable /ralph status text for one workspace. */
export function formatRalphStatus(
  state: RalphWorkspaceState | undefined,
): string {
  if (!state) return "No Ralph loop in this topic.";
  if (!state.active) {
    return [
      `Ralph loop inactive (last run: ${ralphSessionName(state.baseName, state.loop)}).`,
      state.lastNote ? `Last note: ${state.lastNote}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Ralph loop active: iteration #${state.loop + 1} (${ralphSessionName(state.baseName, state.loop)}).`,
    `Exit condition: ${state.exitCondition}`,
    state.lastNote ? `Last note: ${state.lastNote}` : undefined,
    `Safety ceiling: ${state.maxIterations} iterations.`,
    "Use /ralph stop to stop the loop.",
  ]
    .filter(Boolean)
    .join("\n");
}
