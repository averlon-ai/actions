/**
 * The findings the caller's reviewers dismissed (the false-positives input), as this action reports
 * them.
 *
 * The engine gives the dismissals to the scan as reviewer feedback, and the scan decides whether a
 * new finding is one of them: it matches by title and location, since a candidate has no
 * fingerprint until its draft is accepted. A finding the scan still reports whose fingerprint a
 * dismissal names is one a reviewer already judged, so the action files no issue and posts no
 * review comment for it; the reports and the SARIF keep it.
 */
import { at, obj, text } from '@averlon-ai/cynos-scan-engine';
import { readFileSync } from 'node:fs';
import { fingerprintOf } from './issues';

/**
 * The fingerprints the dismissals in file name. The engine checked the file before the scan
 * started (an array of dismissals, each with a reason, a title and a location), so this reads only
 * the optional fingerprint of each.
 */
export function dismissedFingerprints(file: string): Set<string> {
  const entries: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return new Set(
    (Array.isArray(entries) ? entries : [])
      .map(entry => text(at(entry, 'fingerprint')).trim())
      .filter(Boolean)
  );
}

/** The findings without those whose fingerprint was dismissed, and how many those were. */
export function withoutDismissed(
  findings: unknown[],
  dismissed: Set<string>
): { undismissed: unknown[]; dismissed: number } {
  const undismissed = findings.filter(finding => !dismissed.has(fingerprintOf(obj(finding))));
  return { undismissed, dismissed: findings.length - undismissed.length };
}
