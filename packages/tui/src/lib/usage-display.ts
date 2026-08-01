export interface UsageTokenCounts {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function sessionUsageTotal(usage: UsageTokenCounts): number {
  return (
    usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  );
}

export function formatUsageNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
