
export interface BatchRange { start: number; end: number }

/**
 * Pack contiguous input units up to a request budget. Keep a message together
 * if it fits; only a long message is divided at its existing unit boundaries.
 * Cost estimates are supplied by the caller for the actual transport format.
 */
export function planBatchRanges(
  costs: readonly number[], maxCost: number, maxItems: number,
  groups?: readonly (string | number)[],
): BatchRange[] {
  const ranges: BatchRange[] = [];
  let start = 0;
  let used = 0;
  const flush = (end: number) => {
    if (end > start) ranges.push({ start, end });
    start = end;
    used = 0;
  };
  let i = 0;
  while (i < costs.length) {
    let end = i + 1;
    if (groups && groups[i] !== undefined) {
      while (end < costs.length && groups[end] === groups[i]) end++;
    }
    let groupCost = 0;
    for (let j = i; j < end; j++) groupCost += costs[j]!;
    const groupCount = end - i;
    if (i > start && groupCost <= maxCost && groupCount <= maxItems &&
        (used + groupCost > maxCost || i - start + groupCount > maxItems)) flush(i);
    for (; i < end; i++) {
      const cost = costs[i]!;
      if (i > start && (used + cost > maxCost || i - start >= maxItems)) flush(i);
      used += cost;
    }
  }
  flush(costs.length);
  return ranges;
}
