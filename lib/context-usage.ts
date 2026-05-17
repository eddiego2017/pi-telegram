/**
 * Telegram context-usage display footer helpers
 * Zones: telegram outbound, telegram inbound, display metadata
 * Owns formatting the display-only context footer and stripping it from quoted Telegram reply context
 */

export interface TelegramContextUsageSnapshot {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

const CONTEXT_USAGE_FOOTER_SEPARATOR = "—";
const CONTEXT_USAGE_FOOTER_PREFIX = "📊 ctx";
const CONTEXT_USAGE_TOKEN_PATTERN = String.raw`(?:\?|\d+(?:\.\d+)?K)`;
const CONTEXT_USAGE_PERCENT_PATTERN = String.raw`(?:\?|\d+(?:\.\d+)?%)`;
const CONTEXT_USAGE_FOOTER_LINE_PATTERN = String.raw`📊\s*ctx\s+${CONTEXT_USAGE_TOKEN_PATTERN}\/${CONTEXT_USAGE_TOKEN_PATTERN}\s+${CONTEXT_USAGE_PERCENT_PATTERN}`;
const CONTEXT_USAGE_FOOTER_SEPARATOR_PATTERN = String.raw`(?:—|-{3}|─{3,})`;
const CONTEXT_USAGE_FOOTER_PATTERN = new RegExp(
  String.raw`(?:\r?\n){0,2}[\t ]*${CONTEXT_USAGE_FOOTER_SEPARATOR_PATTERN}[\t ]*\r?\n[\t ]*${CONTEXT_USAGE_FOOTER_LINE_PATTERN}[\t ]*(?:\r?\n[\t ]*${CONTEXT_USAGE_FOOTER_SEPARATOR_PATTERN}[\t ]*)?[\t ]*$`,
  "u",
);

function trimTrailingZeroes(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatKilokens(value: number): string {
  return `${trimTrailingZeroes((value / 1000).toFixed(1))}K`;
}

function formatContextPercent(value: number): string {
  const decimals = value > 0 && value < 0.1 ? 2 : 1;
  return `${trimTrailingZeroes(value.toFixed(decimals))}%`;
}

export function formatTelegramContextUsageFooter(
  usage: TelegramContextUsageSnapshot | undefined,
): string | undefined {
  if (!usage || usage.tokens === null || usage.percent === null) {
    return undefined;
  }
  return [
    CONTEXT_USAGE_FOOTER_SEPARATOR,
    `${CONTEXT_USAGE_FOOTER_PREFIX} ${formatKilokens(usage.tokens)}/${formatKilokens(usage.contextWindow)} ${formatContextPercent(usage.percent)}`,
  ].join("\n");
}

export function appendTelegramContextUsageFooter(
  markdown: string,
  footer: string | undefined,
): string {
  if (!footer) return markdown;
  return `${markdown.trimEnd()}\n\n${footer}`;
}

export function stripTelegramContextUsageFooter(text: string): string {
  return text.replace(CONTEXT_USAGE_FOOTER_PATTERN, "").trimEnd();
}
