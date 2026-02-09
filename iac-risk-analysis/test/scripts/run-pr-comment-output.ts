/**
 * One-off script: format PR comment test data with pr-comment and print output.
 * Run from iac-risk-analysis: bun run generate-pr-comment
 * Writes clean markdown to pr-comment-output.md (no debug lines).
 *
 * Normalizes test data: if AccessAnalysis.Summary.RiskSummary is an array (readable JSON),
 * it is stringified so formatScanResult can JSON.parse it as the API would return.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { formatScanResult, hasRisksInResult } from '../../src/pr-comment';

const dataPath = join(process.cwd(), 'test', 'test-data', 'prcommenttestdata.json');
let scanResult = readFileSync(dataPath, 'utf-8');

// Normalize: API returns RiskSummary as JSON string; test data may have it as array
try {
  const parsed = JSON.parse(scanResult) as {
    AccessAnalysis?: { Summary?: { RiskSummary?: unknown } };
  };
  const riskSummary = parsed.AccessAnalysis?.Summary?.RiskSummary;
  if (Array.isArray(riskSummary)) {
    (parsed.AccessAnalysis!.Summary as { RiskSummary: string }).RiskSummary =
      JSON.stringify(riskSummary);
    scanResult = JSON.stringify(parsed, null, 2);
  }
} catch {
  // leave scanResult as-is
}

const commitSha = 'test-commit-abc123';

const hasRisks = hasRisksInResult(scanResult);
const commentBody = formatScanResult(scanResult, commitSha);

const outPath = join(process.cwd(), 'pr-comment-output.md');
writeFileSync(outPath, commentBody, 'utf-8');

console.log('hasRisksInResult:', hasRisks);
console.log('Output written to:', outPath);
console.log('Length:', commentBody.length, 'chars');
