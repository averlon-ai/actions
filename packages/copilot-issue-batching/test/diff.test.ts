import { describe, it, expect } from 'bun:test';
import {
  getNewIssueIds,
  selectItemsNeedingUpdate,
  selectItemsNeedingUpdateSplit,
} from '../src/diff';

type Item = { key: string; fp: string };

describe('selectItemsNeedingUpdate', () => {
  const accessors = {
    getKey: (i: Item) => i.key,
    getFingerprint: (i: Item) => i.fp,
  };

  it('returns all items when existing is empty', () => {
    const items: Item[] = [
      { key: 'a', fp: '1' },
      { key: 'b', fp: '2' },
    ];
    const existing = { byKey: new Map(), issues: [] };
    const result = selectItemsNeedingUpdate(items, accessors, existing);
    expect(result).toHaveLength(2);
    expect(result.map(i => i.key)).toEqual(['a', 'b']);
  });

  it('filters out items with same key and same fingerprint', () => {
    const items: Item[] = [
      { key: 'a', fp: '1' },
      { key: 'b', fp: '2' },
    ];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('a', { fingerprint: '1', issueNumber: 1 });
    byKey.set('b', { fingerprint: '2', issueNumber: 1 });
    const existing = { byKey, issues: [] };
    const result = selectItemsNeedingUpdate(items, accessors, existing);
    expect(result).toHaveLength(0);
  });

  it('includes items with new key', () => {
    const items: Item[] = [
      { key: 'a', fp: '1' },
      { key: 'c', fp: '3' },
    ];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('a', { fingerprint: '1', issueNumber: 1 });
    const existing = { byKey, issues: [] };
    const result = selectItemsNeedingUpdate(items, accessors, existing);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('c');
  });

  it('includes items with same key but different fingerprint', () => {
    const items: Item[] = [{ key: 'a', fp: '1-new' }];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('a', { fingerprint: '1-old', issueNumber: 1 });
    const existing = { byKey, issues: [] };
    const result = selectItemsNeedingUpdate(items, accessors, existing);
    expect(result).toHaveLength(1);
    expect(result[0].fp).toBe('1-new');
  });

  it('excludes items when issues decreased (comma-separated fingerprint)', () => {
    const items: Item[] = [{ key: 'a', fp: '1,2' }];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('a', { fingerprint: '1,2,3', issueNumber: 1 });
    const existing = { byKey, issues: [] };
    const result = selectItemsNeedingUpdate(items, accessors, existing);
    expect(result).toHaveLength(0);
  });

  it('includes items when issues increased (comma-separated fingerprint)', () => {
    const items: Item[] = [{ key: 'a', fp: '1,2,3' }];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('a', { fingerprint: '1,2', issueNumber: 1 });
    const existing = { byKey, issues: [] };
    const result = selectItemsNeedingUpdate(items, accessors, existing);
    expect(result).toHaveLength(1);
    expect(result[0].fp).toBe('1,2,3');
  });
});

describe('selectItemsNeedingUpdateSplit', () => {
  const accessors = {
    getKey: (i: Item) => i.key,
    getFingerprint: (i: Item) => i.fp,
  };

  it('puts issues-decreased resource in neither newItems nor changedItems', () => {
    const items: Item[] = [{ key: 'a', fp: '1' }];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('a', { fingerprint: '1,2', issueNumber: 1 });
    const existing = { byKey, issues: [] };
    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);
    expect(newItems).toHaveLength(0);
    expect(changedItems).toHaveLength(0);
  });
});

describe('getNewIssueIds', () => {
  it('returns only IDs in current not in existing', () => {
    const result = getNewIssueIds('1,2,3', '1,2');
    expect(result.size).toBe(1);
    expect(result.has('3')).toBe(true);
  });

  it('returns empty when current is subset of existing', () => {
    const result = getNewIssueIds('1,2', '1,2,3');
    expect(result.size).toBe(0);
  });

  it('returns empty when fingerprints are empty', () => {
    expect(getNewIssueIds('', '').size).toBe(0);
  });

  it('returns multiple new IDs when several issues added', () => {
    const result = getNewIssueIds('1,2,3,4,5', '1,2');
    expect(result.size).toBe(3);
    expect(result.has('3')).toBe(true);
    expect(result.has('4')).toBe(true);
    expect(result.has('5')).toBe(true);
  });
});

describe('complex scenarios: selectItemsNeedingUpdateSplit', () => {
  const accessors = {
    getKey: (i: Item) => i.key,
    getFingerprint: (i: Item) => i.fp,
  };

  it('mix of new, unchanged, changed (new issues), and decreased', () => {
    const items: Item[] = [
      { key: 'A', fp: '1' }, // new key
      { key: 'B', fp: '2' }, // new key
      { key: 'C', fp: '10' }, // unchanged (same fp)
      { key: 'D', fp: '4,5,6' }, // changed: had 4,5 now 4,5,6 (new: 6)
      { key: 'E', fp: '7' }, // decreased: had 7,8,9
      { key: 'F', fp: '11,12,13' }, // changed: had 11 now 11,12,13 (new: 12,13)
    ];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('C', { fingerprint: '10', issueNumber: 1 });
    byKey.set('D', { fingerprint: '4,5', issueNumber: 1 });
    byKey.set('E', { fingerprint: '7,8,9', issueNumber: 1 });
    byKey.set('F', { fingerprint: '11', issueNumber: 1 });
    const existing = { byKey, issues: [] };

    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);

    expect(newItems).toHaveLength(2);
    expect(newItems.map(i => i.key).sort()).toEqual(['A', 'B']);
    expect(changedItems).toHaveLength(2);
    expect(changedItems.map(i => i.key).sort()).toEqual(['D', 'F']);

    const newIdsD = getNewIssueIds('4,5,6', '4,5');
    expect(newIdsD.size).toBe(1);
    expect(newIdsD.has('6')).toBe(true);

    const newIdsF = getNewIssueIds('11,12,13', '11');
    expect(newIdsF.size).toBe(2);
    expect(newIdsF.has('12')).toBe(true);
    expect(newIdsF.has('13')).toBe(true);
  });

  it('all decreased or unchanged yields empty newItems and changedItems', () => {
    const items: Item[] = [
      { key: 'a', fp: '1' }, // decreased (existing had 1,2)
      { key: 'b', fp: '3,4' }, // unchanged
    ];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('a', { fingerprint: '1,2', issueNumber: 1 });
    byKey.set('b', { fingerprint: '3,4', issueNumber: 1 });
    const existing = { byKey, issues: [] };

    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);

    expect(newItems).toHaveLength(0);
    expect(changedItems).toHaveLength(0);
  });

  it('non-comma fingerprint (opaque) still includes in changedItems when fp differs', () => {
    const items: Item[] = [{ key: 'x', fp: 'opaque-new' }];
    const byKey = new Map<string, { fingerprint: string; issueNumber: number }>();
    byKey.set('x', { fingerprint: 'opaque-old', issueNumber: 1 });
    const existing = { byKey, issues: [] };

    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);

    expect(newItems).toHaveLength(0);
    expect(changedItems).toHaveLength(1);
    expect(changedItems[0].key).toBe('x');
    expect(changedItems[0].fp).toBe('opaque-new');
  });

  it('only new keys: all in newItems, none in changedItems', () => {
    const items: Item[] = [
      { key: 'r1', fp: '1,2' },
      { key: 'r2', fp: '3' },
    ];
    const existing = { byKey: new Map(), issues: [] };

    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(items, accessors, existing);

    expect(newItems).toHaveLength(2);
    expect(changedItems).toHaveLength(0);
  });
});

describe('complex scenarios: consumer flow (filter changed to new issues only)', () => {
  type ResourceItem = { key: string; issues: Array<{ id: string }> };

  const getKey = (i: ResourceItem) => i.key;
  const getFingerprint = (i: ResourceItem) =>
    i.issues
      .map(iss => iss.id)
      .filter(Boolean)
      .sort()
      .join(',');

  it('filtered changed items have only new issue IDs in fingerprint', () => {
    const existing = {
      byKey: new Map<string, { fingerprint: string; issueNumber: number }>(),
      issues: [] as Array<{
        issueNumber: number;
        keys: string[];
        fingerprints: Record<string, string>;
      }>,
    };
    existing.byKey.set('res1', { fingerprint: 'id1,id2', issueNumber: 1 });
    existing.byKey.set('res2', { fingerprint: 'id5', issueNumber: 1 });

    const items: ResourceItem[] = [
      { key: 'res1', issues: [{ id: 'id1' }, { id: 'id2' }, { id: 'id3' }] }, // new: id3
      { key: 'res2', issues: [{ id: 'id5' }, { id: 'id6' }, { id: 'id7' }] }, // new: id6, id7
    ];

    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(
      items,
      {
        getKey,
        getFingerprint,
      },
      existing
    );

    expect(newItems).toHaveLength(0);
    expect(changedItems).toHaveLength(2);

    const filteredChanged = changedItems.map(item => {
      const existingFp = existing.byKey.get(getKey(item))?.fingerprint ?? '';
      const newIds = getNewIssueIds(getFingerprint(item), existingFp);
      const newIssues = item.issues.filter(iss => iss.id && newIds.has(iss.id));
      return { ...item, issues: newIssues };
    });

    expect(filteredChanged[0].issues.map(i => i.id).sort()).toEqual(['id3']);
    expect(getFingerprint(filteredChanged[0])).toBe('id3');

    expect(filteredChanged[1].issues.map(i => i.id).sort()).toEqual(['id6', 'id7']);
    expect(getFingerprint(filteredChanged[1])).toBe('id6,id7');
  });

  it('new items stay full; changed items become new-issues-only', () => {
    const existing = {
      byKey: new Map<string, { fingerprint: string; issueNumber: number }>(),
      issues: [] as Array<{
        issueNumber: number;
        keys: string[];
        fingerprints: Record<string, string>;
      }>,
    };
    existing.byKey.set('existing', { fingerprint: 'a,b', issueNumber: 1 });

    const items: ResourceItem[] = [
      { key: 'new-resource', issues: [{ id: 'x' }, { id: 'y' }] },
      { key: 'existing', issues: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    ];

    const { newItems, changedItems } = selectItemsNeedingUpdateSplit(
      items,
      {
        getKey,
        getFingerprint,
      },
      existing
    );

    const filteredChanged = changedItems.map(item => {
      const existingFp = existing.byKey.get(getKey(item))?.fingerprint ?? '';
      const newIds = getNewIssueIds(getFingerprint(item), existingFp);
      const newIssues = item.issues.filter(iss => iss.id && newIds.has(iss.id));
      return { ...item, issues: newIssues };
    });
    const itemsToSync = [...newItems, ...filteredChanged];

    expect(itemsToSync).toHaveLength(2);
    expect(getKey(itemsToSync[0])).toBe('new-resource');
    expect(getFingerprint(itemsToSync[0])).toBe('x,y');
    expect(getKey(itemsToSync[1])).toBe('existing');
    expect(getFingerprint(itemsToSync[1])).toBe('c');
  });
});
