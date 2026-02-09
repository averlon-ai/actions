import type { BatchAccessors, BatchConfig } from './types';

/**
 * Sorts items by key and chunks into batches respecting maxItemsPerBatch
 * and optionally maxWeightPerBatch (when getWeight is provided).
 */
export function computeBatches<T>(
  items: T[],
  accessors: BatchAccessors<T>,
  config: BatchConfig
): T[][] {
  if (items.length === 0) return [];

  const { getKey, getWeight } = accessors;
  const { maxItemsPerBatch, maxWeightPerBatch } = config;

  const sorted = [...items].sort((a, b) => getKey(a).localeCompare(getKey(b)));
  const batches: T[][] = [];
  let current: T[] = [];
  let currentWeight = 0;

  const weightOf = (item: T): number => (getWeight ? getWeight(item) : 1);
  const maxWeight = maxWeightPerBatch ?? Number.POSITIVE_INFINITY;

  for (const item of sorted) {
    const w = weightOf(item);
    const wouldExceedCount = current.length >= maxItemsPerBatch;
    const wouldExceedWeight = currentWeight + w > maxWeight;

    if (current.length > 0 && (wouldExceedCount || wouldExceedWeight)) {
      batches.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(item);
    currentWeight += w;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
