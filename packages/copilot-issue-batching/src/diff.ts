import type { BatchAccessors, ExistingState } from './types';

/**
 * Returns items that need to be included in a batch: either key is new
 * or fingerprint changed (content changed for same key).
 */
export function selectItemsNeedingUpdate<T>(
  items: T[],
  accessors: BatchAccessors<T>,
  existing: ExistingState
): T[] {
  const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);
  return [...newItems, ...changedItems];
}

/**
 * Same as selectItemsNeedingUpdate but splits into:
 * - newItems: key was not in existing state (new resource)
 * - changedItems: key in existing state and has at least one new issue ID (not in existing).
 * When fingerprint is comma-separated IDs: if the only change is issues decreased, the item
 * is NOT included (we do nothing). Use for "resource with new issues" in its own batch.
 */
function parseFingerprintAsIds(fingerprint: string): Set<string> | null {
  if (fingerprint === '') return new Set();
  const parts = fingerprint
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? new Set(parts) : null;
}

/**
 * Returns the set of issue IDs that are in current fingerprint but not in existing.
 * Use when building "changed" items so the new batch shows only the new issues.
 * Assumes fingerprints are comma-separated IDs (e.g. sorted issue IDs).
 */
export function getNewIssueIds(
  currentFingerprint: string,
  existingFingerprint: string
): Set<string> {
  const currentIds = parseFingerprintAsIds(currentFingerprint);
  const existingIds = parseFingerprintAsIds(existingFingerprint);
  if (currentIds === null || existingIds === null) return new Set();
  return new Set([...currentIds].filter(id => !existingIds.has(id)));
}

export function selectItemsNeedingUpdateSplit<T>(
  items: T[],
  accessors: BatchAccessors<T>,
  existing: ExistingState
): { newItems: T[]; changedItems: T[] } {
  const { getKey, getFingerprint } = accessors;
  const newItems: T[] = [];
  const changedItems: T[] = [];

  for (const item of items) {
    const key = getKey(item);
    const fingerprint = getFingerprint(item);
    const existingEntry = existing.byKey.get(key);

    if (!existingEntry) {
      newItems.push(item);
      continue;
    }
    if (existingEntry.fingerprint === fingerprint) {
      continue;
    }
    // Fingerprint changed: only include if there are NEW issue IDs (issues increased).
    // If issues decreased (current ⊆ existing), do nothing.
    const currentIds = parseFingerprintAsIds(fingerprint);
    const existingIds = parseFingerprintAsIds(existingEntry.fingerprint);
    if (currentIds !== null && existingIds !== null) {
      const hasNewIds = [...currentIds].some(id => !existingIds.has(id));
      if (!hasNewIds) continue; // same or decreased — skip
    }
    changedItems.push(item);
  }

  return { newItems, changedItems };
}
