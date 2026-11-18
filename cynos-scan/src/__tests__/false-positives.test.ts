import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dismissedFingerprints, withoutDismissed } from '../false-positives';

const DISMISSED = 'codex-security/v1:sha256:aa';

function finding(fingerprint: string): Record<string, unknown> {
  return { title: `Finding ${fingerprint}`, fingerprints: { primary: fingerprint } };
}

function falsePositivesFile(entries: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'false-positives-')), 'false-positives.json');
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

describe('false-positives', () => {
  it('reads the fingerprint of each dismissal that has one', () => {
    const location = [{ path: 'app.py', startLine: 3 }];
    const file = falsePositivesFile([
      { reason: 'Admin only', title: 'SQL injection', locations: location, fingerprint: DISMISSED },
      { reason: 'Test code', title: 'Hardcoded key', locations: location },
      { reason: 'Blank', title: 'XSS', locations: location, fingerprint: '  ' },
    ]);
    expect([...dismissedFingerprints(file)]).toEqual([DISMISSED]);
  });

  it('leaves out the findings whose fingerprint was dismissed, and counts them', () => {
    const kept = finding('codex-security/v1:sha256:bb');
    const unfingerprinted = { title: 'No fingerprint' };
    expect(
      withoutDismissed([finding(DISMISSED), kept, unfingerprinted], new Set([DISMISSED]))
    ).toEqual({ undismissed: [kept, unfingerprinted], dismissed: 1 });
  });

  it('keeps every finding when nothing was dismissed', () => {
    const findings = [finding(DISMISSED)];
    expect(withoutDismissed(findings, new Set())).toEqual({ undismissed: findings, dismissed: 0 });
  });
});
