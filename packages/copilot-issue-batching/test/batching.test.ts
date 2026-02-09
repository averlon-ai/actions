import { describe, it, expect } from 'bun:test';
import { computeBatches } from '../src/batching';

type Item = { key: string; w?: number };

describe('computeBatches', () => {
  const getKey = (i: Item) => i.key;
  const getWeight = (i: Item) => i.w ?? 1;

  it('returns empty array for empty items', () => {
    expect(
      computeBatches([], { getKey, getFingerprint: () => '' }, { maxItemsPerBatch: 10 })
    ).toEqual([]);
  });

  it('chunks by maxItemsPerBatch only', () => {
    const items: Item[] = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'e' }];
    const batches = computeBatches(
      items,
      { getKey, getFingerprint: () => '' },
      { maxItemsPerBatch: 2 }
    );
    expect(batches).toHaveLength(3);
    expect(batches[0].map(getKey)).toEqual(['a', 'b']);
    expect(batches[1].map(getKey)).toEqual(['c', 'd']);
    expect(batches[2].map(getKey)).toEqual(['e']);
  });

  it('sorts by key before chunking', () => {
    const items: Item[] = [{ key: 'z' }, { key: 'a' }, { key: 'm' }];
    const batches = computeBatches(
      items,
      { getKey, getFingerprint: () => '' },
      { maxItemsPerBatch: 2 }
    );
    expect(batches).toHaveLength(2);
    expect(batches[0].map(getKey)).toEqual(['a', 'm']);
    expect(batches[1].map(getKey)).toEqual(['z']);
  });

  it('respects maxWeightPerBatch when getWeight provided', () => {
    const items: Item[] = [
      { key: 'a', w: 10 },
      { key: 'b', w: 10 },
      { key: 'c', w: 15 },
    ];
    const batches = computeBatches(
      items,
      { getKey, getFingerprint: () => '', getWeight },
      { maxItemsPerBatch: 10, maxWeightPerBatch: 20 }
    );
    expect(batches).toHaveLength(2);
    expect(batches[0].map(getKey)).toEqual(['a', 'b']);
    expect(batches[1].map(getKey)).toEqual(['c']);
  });
});

describe('complex scenario: new + changed batches (sync flow)', () => {
  const getKey = (i: Item) => i.key;
  const getFingerprint = () => '';
  const config = { maxItemsPerBatch: 2 };

  it('newItems and changedItems batched separately then concatenated', () => {
    const newItems: Item[] = [{ key: 'n1' }, { key: 'n2' }, { key: 'n3' }];
    const changedItems: Item[] = [{ key: 'c1' }, { key: 'c2' }];

    const newBatches = computeBatches(newItems, { getKey, getFingerprint }, config);
    const changedBatches = computeBatches(changedItems, { getKey, getFingerprint }, config);
    const batches = [...newBatches, ...changedBatches];
    const createOnlyStartIndex = newBatches.length;

    expect(batches).toHaveLength(3);
    expect(batches[0].map(getKey)).toEqual(['n1', 'n2']);
    expect(batches[1].map(getKey)).toEqual(['n3']);
    expect(batches[2].map(getKey)).toEqual(['c1', 'c2']);
    expect(createOnlyStartIndex).toBe(2);
    expect(batches.slice(0, createOnlyStartIndex).every((_, i) => i < createOnlyStartIndex)).toBe(
      true
    );
    expect(batches.slice(createOnlyStartIndex).length).toBe(1);
  });
});
