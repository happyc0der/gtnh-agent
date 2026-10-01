import { describe, expect, it } from 'vitest';
import { nearestOfEachKind } from '../../src/domain/blocks.ts';

describe('nearestOfEachKind', () => {
  /** "a3": the third nearest block of kind a. */
  const kindOf = (s: string): string => s.charAt(0);

  it('keeps everything, in order, when it fits', () => {
    expect(nearestOfEachKind(['a1', 'b1', 'a2'], kindOf, 3)).toEqual(['a1', 'b1', 'a2']);
  });

  it("lists every kind's nearest before any kind's second, and stays nearest first", () => {
    // Kind a crowds the nearest places; b and c are farther out.
    const nearestFirst = ['a1', 'a2', 'a3', 'a4', 'b1', 'a5', 'c1', 'b2', 'c2'];
    expect(nearestOfEachKind(nearestFirst, kindOf, 3)).toEqual(['a1', 'b1', 'c1']);
    expect(nearestOfEachKind(nearestFirst, kindOf, 5)).toEqual(['a1', 'a2', 'b1', 'c1', 'b2']);
  });

  it('with more kinds than it may list, leaves out the kinds whose nearest is farthest', () => {
    expect(nearestOfEachKind(['a1', 'b1', 'a2', 'c1', 'd1'], kindOf, 2)).toEqual(['a1', 'b1']);
    expect(nearestOfEachKind(['a1', 'b1'], kindOf, 0)).toEqual([]);
  });
});
