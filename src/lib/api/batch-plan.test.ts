
import { describe, expect, it } from 'vitest';
import { planBatchRanges } from './batch-plan';

describe('request budget planner', () => {
  it('packs many short items instead of dividing at a fixed five', () => {
    expect(planBatchRanges(Array(24).fill(50), 4600, 64)).toEqual([{ start: 0, end: 24 }]);
  });
  it('keeps the next message together when it fits a fresh request', () => {
    expect(planBatchRanges([4, 4, 3, 3], 10, 64, ['a', 'a', 'b', 'b']))
      .toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });
  it('splits a long message only at complete units', () => {
    expect(planBatchRanges([4, 4, 4, 4], 10, 64, ['a', 'a', 'a', 'a']))
      .toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  });
  it('bounds item counts and handles an oversize indivisible unit', () => {
    expect(planBatchRanges([100, 1, 1, 1], 10, 2))
      .toEqual([{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }]);
    expect(planBatchRanges([], 10, 2)).toEqual([]);
  });
});
