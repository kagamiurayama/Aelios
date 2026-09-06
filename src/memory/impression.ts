// Issue #35: diary / impressions are mood, not verified events.

export const IMPRESSION_DISCLAIMER = "印象性总结，具体事实请回溯正本。";

export function groundedSourceIds(claimed: string[], known: string[]): string[] {
  const allow = new Set(known.filter(Boolean));
  return [...new Set(claimed.filter((id) => allow.has(id)))];
}

export function withImpressionDisclaimer<T extends Record<string, unknown>>(row: T): T & { disclaimer: string } {
  return { ...row, disclaimer: IMPRESSION_DISCLAIMER };
}
