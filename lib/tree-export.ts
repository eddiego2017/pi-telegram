/**
 * Telegram session tree SVG/PNG export helpers
 * Zones: session tree graph, SVG rendering, export files
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Resvg } from "@resvg/resvg-js";

import type {
  TelegramTreeContentBlock,
  TelegramTreeSessionEntry,
  TelegramTreeSnapshot,
} from "./menu-tree.ts";
import { buildTelegramMultipartReplyParameters } from "./replies.ts";

const TREE_EXPORT_MARGIN = 44;
const TREE_EXPORT_ROW_HEIGHT = 92;
const TREE_EXPORT_LANE_WIDTH = 380;
const TREE_EXPORT_NODE_RADIUS = 15;
const TREE_EXPORT_HEADER_HEIGHT = 70;
const TREE_EXPORT_FOOTER_HEIGHT = 40;
const TREE_EXPORT_LABEL_LINE_CELLS = 34;
const TREE_EXPORT_LABEL_MAX_LINES = 2;
const TREE_EXPORT_MIN_WIDTH = 900;

export interface TelegramTreeExportFileSet {
  svgPath: string;
  pngPath: string;
  fileBaseName: string;
  nodeCount: number;
  width: number;
  height: number;
}

export interface TelegramTreeExportFileSenderDeps {
  sendMultipart: <TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<TResponse>;
}

interface ExportNode {
  id: string;
  parentId?: string;
  children: ExportNode[];
  order: number;
  timestampOrder: number;
  active: boolean;
  activeOrder?: number;
  leaf: boolean;
  ordinal: number;
  summary: string;
}

interface NodePosition {
  x: number;
  y: number;
}

function getTelegramTreeExportTempDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "tmp", "telegram-tree");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanText(s: string): string {
  return s
    .replace(/^\[telegram[^\]]*\]\s*/i, "")
    .replace(/\n\[reply[^\n]*\][\s\S]*$/i, "")
    .replace(/\n\[attachments\][\s\S]*$/i, "")
    .replace(/\n\[outputs\][\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function charDisplayCells(char: string): number {
  if (/\p{Mark}/u.test(char)) return 0;
  const codePoint = char.codePointAt(0) ?? 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

function stringDisplayCells(s: string): number {
  return [...s].reduce((total, char) => total + charDisplayCells(char), 0);
}

function truncateCells(s: string, maxCells: number): string {
  const clean = cleanText(s);
  let result = "";
  let cells = 0;
  for (const char of clean) {
    const nextCells = cells + charDisplayCells(char);
    if (nextCells > maxCells) return `${result.trimEnd()}…`;
    result += char;
    cells = nextCells;
  }
  return result;
}

function truncate(s: string, n: number): string {
  return truncateCells(s, n);
}

function wrapCells(s: string, maxCells: number, maxLines: number): string[] {
  const clean = cleanText(s);
  if (!clean) return ["(empty)"];
  const lines: string[] = [];
  let current = "";
  let currentCells = 0;
  for (const char of clean) {
    const charCells = charDisplayCells(char);
    if (current && currentCells + charCells > maxCells) {
      lines.push(current.trimEnd());
      current = "";
      currentCells = 0;
      if (lines.length >= maxLines) break;
    }
    current += char;
    currentCells += charCells;
  }
  if (lines.length < maxLines && current) lines.push(current.trimEnd());
  if (lines.length === 0) lines.push("(empty)");
  if (stringDisplayCells(clean) > lines.reduce((sum, line) => sum + stringDisplayCells(line), 0)) {
    const last = lines.length - 1;
    lines[last] = truncateCells(`${lines[last] ?? ""}…`, maxCells);
  }
  return lines;
}

function contentText(content: string | TelegramTreeContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function isVisiblePromptEntry(entry: TelegramTreeSessionEntry): boolean {
  if (entry.type === "message") return entry.message?.role === "user";
  return entry.type === "custom_message" && entry.display !== false;
}

function entrySummary(entry: TelegramTreeSessionEntry): string {
  if (entry.type === "message") {
    return contentText(entry.message?.content) || `(${entry.message?.role ?? "message"})`;
  }
  if (entry.type === "custom_message") {
    return contentText(entry.content) || `custom: ${entry.customType ?? "message"}`;
  }
  return entry.summary || entry.label || entry.type;
}

function entryTimestampOrder(entry: TelegramTreeSessionEntry, fallback: number): number {
  if (!entry.timestamp) return fallback;
  const value = new Date(entry.timestamp).getTime();
  return Number.isFinite(value) ? value : fallback;
}

function findVisibleParentId(
  entry: TelegramTreeSessionEntry,
  byId: Map<string, TelegramTreeSessionEntry>,
  visibleIds: Set<string>,
): string | undefined {
  const seen = new Set<string>();
  let parentId = entry.parentId ?? undefined;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    if (visibleIds.has(parentId)) return parentId;
    parentId = byId.get(parentId)?.parentId ?? undefined;
  }
  return undefined;
}

function buildExportNodes(snapshot: TelegramTreeSnapshot): ExportNode[] {
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry] as const));
  const visibleEntries = snapshot.entries.filter(isVisiblePromptEntry);
  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const activeIds = new Set(snapshot.branch.map((entry) => entry.id));
  const activeOrderById = new Map(snapshot.branch.map((entry, index) => [entry.id, index] as const));
  const childIds = new Set(
    snapshot.entries
      .map((entry) => entry.parentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const sorted = [...visibleEntries].sort((a, b) => {
    const ai = snapshot.entries.indexOf(a);
    const bi = snapshot.entries.indexOf(b);
    const at = entryTimestampOrder(a, ai);
    const bt = entryTimestampOrder(b, bi);
    return at === bt ? ai - bi : at - bt;
  });
  const ordinalById = new Map(sorted.map((entry, index) => [entry.id, index + 1] as const));
  const nodes = visibleEntries.map((entry, index): ExportNode => ({
    id: entry.id,
    parentId: findVisibleParentId(entry, byId, visibleIds),
    children: [],
    order: index,
    timestampOrder: entryTimestampOrder(entry, index),
    active: activeIds.has(entry.id),
    activeOrder: activeOrderById.get(entry.id),
    leaf: !childIds.has(entry.id),
    ordinal: ordinalById.get(entry.id) ?? index + 1,
    summary: truncateCells(
      entrySummary(entry),
      TREE_EXPORT_LABEL_LINE_CELLS * TREE_EXPORT_LABEL_MAX_LINES,
    ),
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  for (const node of nodes) {
    if (!node.parentId) continue;
    nodeById.get(node.parentId)?.children.push(node);
  }
  for (const node of nodes) {
    node.children.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.timestampOrder === b.timestampOrder
        ? a.order - b.order
        : a.timestampOrder - b.timestampOrder;
    });
  }
  return nodes;
}

function layoutExportNodes(nodes: ExportNode[]): {
  positions: Map<string, NodePosition>;
  width: number;
  height: number;
} {
  const positions = new Map<string, NodePosition>();
  const activeNodes = nodes
    .filter((node) => node.active)
    .sort((a, b) => (a.activeOrder ?? a.order) - (b.activeOrder ?? b.order));
  const roots = nodes
    .filter((node) => !node.parentId || !nodes.some((candidate) => candidate.id === node.parentId))
    .sort((a, b) => a.timestampOrder === b.timestampOrder ? a.order - b.order : a.timestampOrder - b.timestampOrder);
  const activeX = TREE_EXPORT_MARGIN + TREE_EXPORT_NODE_RADIUS;
  let maxX = activeX;
  let maxY = TREE_EXPORT_HEADER_HEIGHT;

  if (activeNodes.length > 0) {
    activeNodes.forEach((node, index) => {
      const y = TREE_EXPORT_HEADER_HEIGHT + index * TREE_EXPORT_ROW_HEIGHT;
      positions.set(node.id, { x: activeX, y });
      maxY = Math.max(maxY, y);
    });
  }

  let laneCount = 0;
  const laneNextY: number[] = [];
  const allocateLane = (): number => laneCount++;

  const placeSubtree = (node: ExportNode, lane: number, minY: number): void => {
    const x = activeX + (lane + 1) * TREE_EXPORT_LANE_WIDTH;
    const y = Math.max(minY, laneNextY[lane] ?? TREE_EXPORT_HEADER_HEIGHT);
    positions.set(node.id, { x, y });
    laneNextY[lane] = y + TREE_EXPORT_ROW_HEIGHT;
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    const children = node.children.filter((child) => !child.active);
    children.forEach((child, index) => {
      const childLane = index === 0 ? lane : allocateLane();
      placeSubtree(child, childLane, y + TREE_EXPORT_ROW_HEIGHT);
    });
  };

  const placeInactiveChild = (child: ExportNode, parent: ExportNode | undefined): void => {
    const lane = allocateLane();
    const parentY = parent ? positions.get(parent.id)?.y : undefined;
    placeSubtree(child, lane, (parentY ?? TREE_EXPORT_HEADER_HEIGHT - TREE_EXPORT_ROW_HEIGHT) + TREE_EXPORT_ROW_HEIGHT);
  };

  for (const node of activeNodes) {
    for (const child of node.children) {
      if (!child.active) placeInactiveChild(child, node);
    }
  }
  for (const root of roots) {
    if (!positions.has(root.id)) placeInactiveChild(root, undefined);
  }

  return {
    positions,
    width: Math.max(TREE_EXPORT_MIN_WIDTH, maxX + TREE_EXPORT_LANE_WIDTH),
    height: Math.max(220, maxY + TREE_EXPORT_FOOTER_HEIGHT),
  };
}

function renderEdge(parent: NodePosition, child: NodePosition, active: boolean): string {
  const stroke = active ? "#16a34a" : "#94a3b8";
  const width = active ? 3 : 2;
  if (parent.x === child.x) {
    return `<path d="M ${parent.x} ${parent.y + TREE_EXPORT_NODE_RADIUS} L ${child.x} ${child.y - TREE_EXPORT_NODE_RADIUS}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`;
  }
  const startY = parent.y + TREE_EXPORT_NODE_RADIUS;
  const endX = child.x - TREE_EXPORT_NODE_RADIUS;
  return `<path d="M ${parent.x} ${startY} L ${parent.x} ${child.y} L ${endX} ${child.y}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function renderNode(node: ExportNode, position: NodePosition, currentLeafId?: string | null): string {
  const active = node.active;
  const current = currentLeafId === node.id;
  const fill = active ? "#22c55e" : "#f59e0b";
  const stroke = current ? "#2563eb" : active ? "#15803d" : "#b45309";
  const textColor = active ? "#052e16" : "#451a03";
  const labelX = position.x + TREE_EXPORT_NODE_RADIUS + 8;
  const lines = wrapCells(
    node.summary || "(empty)",
    TREE_EXPORT_LABEL_LINE_CELLS,
    TREE_EXPORT_LABEL_MAX_LINES,
  );
  const label = [
    `<text x="${labelX}" y="${position.y - 6}" font-size="15" fill="#0f172a">`,
    ...lines.map((line, index) => (
      `<tspan x="${labelX}" dy="${index === 0 ? 0 : 18}">${escapeXml(line)}</tspan>`
    )),
    `</text>`,
  ].join("\n");
  const leaf = node.leaf
    ? `<text x="${labelX}" y="${position.y + 32}" font-size="12" fill="#64748b">leaf ${escapeXml(node.id.slice(0, 8))}</text>`
    : "";
  return [
    `<circle cx="${position.x}" cy="${position.y}" r="${TREE_EXPORT_NODE_RADIUS}" fill="${fill}" stroke="${stroke}" stroke-width="${current ? 5 : 2}"/>`,
    `<text x="${position.x}" y="${position.y + 5}" text-anchor="middle" font-size="12" font-weight="700" fill="${textColor}">${node.ordinal}</text>`,
    label,
    leaf,
  ].filter(Boolean).join("\n");
}

export function buildTelegramTreeSvg(snapshot: TelegramTreeSnapshot): string {
  const nodes = buildExportNodes(snapshot);
  const { positions, width, height } = layoutExportNodes(nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const edges: string[] = [];
  for (const node of nodes) {
    if (!node.parentId) continue;
    const parent = nodeById.get(node.parentId);
    const parentPosition = parent ? positions.get(parent.id) : undefined;
    const nodePosition = positions.get(node.id);
    if (!parent || !parentPosition || !nodePosition) continue;
    edges.push(renderEdge(parentPosition, nodePosition, parent.active && node.active));
  }
  const renderedNodes = nodes
    .filter((node) => positions.has(node.id))
    .sort((a, b) => a.timestampOrder === b.timestampOrder ? a.order - b.order : a.timestampOrder - b.timestampOrder)
    .map((node) => renderNode(node, positions.get(node.id)!, snapshot.leafId));
  const cwd = truncate(snapshot.cwd, 70);
  const leaf = snapshot.leafId ? snapshot.leafId.slice(0, 8) : "root";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="${TREE_EXPORT_MARGIN}" y="30" font-size="22" font-weight="700" fill="#0f172a">Session tree</text>
  <text x="${TREE_EXPORT_MARGIN}" y="54" font-size="14" fill="#475569">${escapeXml(cwd)} · ${nodes.length} prompts · leaf ${escapeXml(leaf)}</text>
  <g font-family="Noto Sans CJK TC, Noto Sans CJK, Noto Sans, Arial, sans-serif">
    ${edges.join("\n    ")}
    ${renderedNodes.join("\n    ")}
  </g>
  <g font-family="Noto Sans CJK TC, Noto Sans CJK, Noto Sans, Arial, sans-serif" font-size="13" fill="#475569">
    <circle cx="${TREE_EXPORT_MARGIN}" cy="${height - 20}" r="7" fill="#22c55e"/><text x="${TREE_EXPORT_MARGIN + 14}" y="${height - 16}">active path</text>
    <circle cx="${TREE_EXPORT_MARGIN + 120}" cy="${height - 20}" r="7" fill="#f59e0b"/><text x="${TREE_EXPORT_MARGIN + 134}" y="${height - 16}">inactive branch</text>
    <circle cx="${TREE_EXPORT_MARGIN + 275}" cy="${height - 20}" r="7" fill="#22c55e" stroke="#2563eb" stroke-width="3"/><text x="${TREE_EXPORT_MARGIN + 289}" y="${height - 16}">current leaf</text>
  </g>
</svg>`;
}

export function createTelegramTreeExportFileSender(
  deps: TelegramTreeExportFileSenderDeps,
): (
  chatId: number,
  replyToMessageId: number,
  files: TelegramTreeExportFileSet,
) => Promise<void> {
  return async function sendTelegramTreeExportFiles(chatId, replyToMessageId, files) {
    const replyParameters = buildTelegramMultipartReplyParameters(replyToMessageId);
    const caption = `Session tree (${files.nodeCount} prompts, ${files.width}×${files.height})`;
    await deps.sendMultipart(
      "sendDocument",
      {
        chat_id: String(chatId),
        caption,
        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
      },
      "document",
      files.pngPath,
      `${files.fileBaseName}.png`,
    );
    await deps.sendMultipart(
      "sendDocument",
      { chat_id: String(chatId), caption: "Session tree SVG source" },
      "document",
      files.svgPath,
      `${files.fileBaseName}.svg`,
    );
  };
}

export async function renderTelegramTreeExportFiles(
  snapshot: TelegramTreeSnapshot,
  options?: { outputDir?: string },
): Promise<TelegramTreeExportFileSet> {
  const outputDir = options?.outputDir ?? getTelegramTreeExportTempDir();
  await mkdir(outputDir, { recursive: true });
  const svg = buildTelegramTreeSvg(snapshot);
  const size = svg.match(/width="(\d+)" height="(\d+)"/);
  const width = size ? Number.parseInt(size[1] ?? "0", 10) : 0;
  const height = size ? Number.parseInt(size[2] ?? "0", 10) : 0;
  const safeSession = snapshot.sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48) || "session";
  const fileBaseName = `session-tree-${safeSession}-${randomUUID().slice(0, 8)}`;
  const svgPath = join(outputDir, `${fileBaseName}.svg`);
  const pngPath = join(outputDir, `${fileBaseName}.png`);
  await writeFile(svgPath, svg, "utf8");
  const png = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: { loadSystemFonts: true },
  }).render().asPng();
  await writeFile(pngPath, png);
  return {
    svgPath,
    pngPath,
    fileBaseName,
    nodeCount: buildExportNodes(snapshot).length,
    width,
    height,
  };
}
