import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AnalyzeTerraformResult, AccessRiskAssessment, RiskAssessment } from '@averlon/shared';

/** API may return targetResources (array) or targetResource (string) */
type AccessRiskItem = AccessRiskAssessment & { targetResources?: string[] };

export type CommentMode = 'always' | 'update' | 'on-security-risks';

/**
 * HTML comment markers used to identify Averlon scan comments for updates.
 * Separate markers for reachability vs access so we can post/update two comments.
 */
const COMMENT_MARKER_REACHABILITY = '<!-- averlon-terraform-reachability -->';
const COMMENT_MARKER_ACCESS = '<!-- averlon-terraform-access -->';

/** GitHub API limit for issue/PR comment body (characters). */
export const GITHUB_COMMENT_BODY_MAX_LENGTH = 65_536;

const TRUNCATION_FOOTER_NO_LINK = '\n\n---\n_Full report available in workflow artifacts._';

function buildTruncationFooter(workflowRunUrl?: string): string {
  if (workflowRunUrl?.trim()) {
    return `\n\n---\n**[Show detailed summary (logs & artifacts)](${workflowRunUrl.trim()})**`;
  }
  return TRUNCATION_FOOTER_NO_LINK;
}

/**
 * Truncate comment body to fit GitHub's limit and append a footer.
 * Cuts at the last newline before the limit to avoid breaking mid-line.
 * When workflowRunUrl is provided, footer includes a link to the run (logs & artifacts).
 */
export function enforceCommentBodyLimit(
  body: string,
  maxLength: number = GITHUB_COMMENT_BODY_MAX_LENGTH,
  workflowRunUrl?: string
): string {
  if (body.length <= maxLength) return body;
  const footer = buildTruncationFooter(workflowRunUrl);
  const maxContentLength = maxLength - footer.length;
  const slice = body.slice(0, maxContentLength);
  const lastNewline = slice.lastIndexOf('\n');
  const cutIndex = lastNewline >= 0 ? lastNewline + 1 : maxContentLength;
  return body.slice(0, cutIndex).trimEnd() + footer;
}

/**
 * Format impactAssessment text: split on " N) " at start or after a period, render as bold label + body.
 * Example: "1) Attack Vector: ... 2) Exploitation Path: ..." → markdown list with **Label**: body.
 * If the text does not contain the numbered pattern, return it as-is.
 * Splits only on "1) " at start or " . N) " so we don't break "(1 of 1)" or "of 1)" in sentences.
 */
function formatImpactAssessment(text: string): string {
  if (!text?.trim()) return '';
  // Only apply when we see "1) " at start or " . 2) " etc. (number at start or after period)
  if (!/^\d+\)\s+/.test(text) && !/\.\s+\d+\)\s+/.test(text)) return text;
  // Split on "N) " at start or after ". " so "(1 of 1)" and "of 1)" are not split.
  // (?<=^) anchors the match at the start of the string; (?<=\.) anchors it immediately after a period.
  const listPattern = /(?<=^)\d+\)\s+|(?<=\.)\s+\d+\)\s+/;
  const segments = text.split(listPattern).filter(s => s.trim().length > 0);
  return segments
    .map(seg => {
      const s = seg.trim();
      const colonIndex = s.indexOf(': ');
      if (colonIndex === -1) return `- ${s}`;
      const label = s.slice(0, colonIndex).trim();
      const body = s.slice(colonIndex + 2).trim();
      return `- **${label}**: ${body}`;
    })
    .join('\n\n');
}

function buildCommentShell(
  marker: string,
  title: string,
  statusEmoji: string,
  statusText: string,
  resultSummary: string,
  detailsJson: string,
  commitSha: string
): string {
  return `${marker}
## ${statusEmoji} ${title}

**Status**: ${statusText}

${resultSummary || '*No significant changes detected.*'}

<details>
<summary>📋 Full Scan Results (Click to expand)</summary>

\`\`\`json
${detailsJson}
\`\`\`

</details>

---
*Analysis performed on commit: \`${commitSha}\`*
*Powered by [Averlon Security](https://averlon.io)*
`;
}

/**
 * Format reachability analysis only (Summary, New Internet Exposures, Risk Assessment).
 * Used for the first of two PR comments (reachability).
 */
export function formatReachabilityComment(scanResult: string, commitSha: string): string {
  let parsedResult: AnalyzeTerraformResult;
  let resultSummary = '';
  let hasRisks = false;

  try {
    parsedResult = JSON.parse(scanResult);
    const summaryData = parsedResult.ReachabilityAnalysis?.Summary;

    if (summaryData) {
      if (summaryData.TextSummary) {
        resultSummary += `### 📝 Summary\n\n${summaryData.TextSummary}\n\n`;
      }
      if (summaryData.NewInternetExposures && summaryData.NewInternetExposures.length > 0) {
        hasRisks = true;
        core.info(`Found ${summaryData.NewInternetExposures.length} new internet exposure(s)`);
        resultSummary += `### 🌐 New Internet Exposures\n\n`;
        resultSummary += `The following resources will be exposed to the internet:\n\n`;
        summaryData.NewInternetExposures.forEach((resource, index) => {
          resultSummary += `${index + 1}. \`${resource}\`\n`;
        });
        resultSummary += `\n`;
      }
      if (summaryData.RiskSummary) {
        try {
          const riskData: RiskAssessment[] = JSON.parse(summaryData.RiskSummary);
          if (Array.isArray(riskData) && riskData.length > 0) {
            hasRisks = true;
            core.info(`Found ${riskData.length} risk assessment(s)`);
            resultSummary += `### ⚠️ Risk Assessment\n\n`;
            riskData.forEach((risk, index) => {
              const riskLevel = risk.riskAssessment?.riskLevel || 'Unknown';
              const riskEmoji = getSeverityEmoji(riskLevel);
              resultSummary += `#### ${riskEmoji} Resource ${index + 1}: \`${risk.terraformResource || 'Unknown'}\`\n\n`;
              resultSummary += `- **Cloud Resource**: \`${risk.cloudResource || 'Unknown'}\`\n`;
              resultSummary += `- **Risk Level**: **${riskLevel}**\n\n`;
              if (risk.riskAssessment?.issuesSummary) {
                resultSummary += `**Issues summary:**\n\n${risk.riskAssessment.issuesSummary}\n\n`;
              }
              if (risk.riskAssessment?.impactAssessment) {
                resultSummary += `**Impact:**\n\n${formatImpactAssessment(risk.riskAssessment.impactAssessment)}\n\n`;
              }
              if (
                risk.riskAssessment?.vulnerabilities &&
                risk.riskAssessment.vulnerabilities.length > 0
              ) {
                resultSummary += `\n**Vulnerabilities:**\n`;
                risk.riskAssessment.vulnerabilities.forEach(vuln => {
                  const severityEmoji = getSeverityEmoji(vuln.severity);
                  resultSummary += `- ${severityEmoji} **${vuln.cve || 'Unknown CVE'}** (${vuln.severity || 'Unknown'})\n`;
                  if (vuln.riskAnalysis) resultSummary += `  - ${vuln.riskAnalysis}\n`;
                });
              }
              resultSummary += `\n`;
            });
          }
        } catch {
          core.warning('Failed to parse RiskSummary as JSON, displaying as text');
          resultSummary += `### ⚠️ Risk Assessment\n\n${summaryData.RiskSummary}\n\n`;
        }
      }
    }

    const statusEmoji = hasRisks ? '⚠️' : '✅';
    const statusText = hasRisks ? 'Security Issues Detected' : 'No Security Issues Detected';
    const detailsJson = JSON.stringify(
      { ReachabilityAnalysis: parsedResult.ReachabilityAnalysis },
      null,
      2
    );
    return buildCommentShell(
      COMMENT_MARKER_REACHABILITY,
      'Terraform Reachability Analysis',
      statusEmoji,
      statusText,
      resultSummary,
      detailsJson,
      commitSha
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(`Failed to parse scan result for reachability: ${errorMessage}`);
    return buildCommentShell(
      COMMENT_MARKER_REACHABILITY,
      'Terraform Reachability Analysis',
      '⚠️',
      'Security Issues Detected',
      `\n⚠️ Unable to parse the detailed results. Please check the raw output below.\n\n`,
      scanResult,
      commitSha
    );
  }
}

/**
 * Format access analysis only (Access Risk Assessment: permissions + Summary.RiskSummary).
 * Used for the second of two PR comments (access).
 */
export function formatAccessComment(scanResult: string, commitSha: string): string {
  let parsedResult: AnalyzeTerraformResult;
  let resultSummary = '';
  let hasRisks = false;

  try {
    parsedResult = JSON.parse(scanResult);
    const accessAnalysis = parsedResult.AccessAnalysis;
    const accessPermissions = accessAnalysis?.AccessPermissions;

    if (accessPermissions && accessPermissions.length > 0) {
      const hasActualChanges = accessPermissions.some(
        perm => (perm.Added && perm.Added.length > 0) || (perm.Removed && perm.Removed.length > 0)
      );
      if (hasActualChanges) {
        hasRisks = true;
        core.info(`Found ${accessPermissions.length} access permission change(s)`);
        resultSummary += `### 🔑 Permission Changes\n\n`;
        accessPermissions.forEach(perm => {
          const principalId = perm.PrincipalID || 'Unknown Principal';
          const targetResource = perm.TargetResourceID || 'Unknown Resource';
          const hasChanges =
            (perm.Added && perm.Added.length > 0) || (perm.Removed && perm.Removed.length > 0);
          if (hasChanges) {
            resultSummary += `#### \`${principalId}\` → \`${targetResource}\`\n\n`;
            if (perm.Added && perm.Added.length > 0) {
              resultSummary += `**➕ Added Permissions:**\n`;
              perm.Added.forEach(p => {
                resultSummary += `- \`${p}\`\n`;
              });
              resultSummary += `\n`;
            }
            if (perm.Removed && perm.Removed.length > 0) {
              resultSummary += `**➖ Removed Permissions:**\n`;
              perm.Removed.forEach(p => {
                resultSummary += `- \`${p}\`\n`;
              });
              resultSummary += `\n`;
            }
          }
        });
      }
    }

    const accessSummary = accessAnalysis?.Summary;
    if (accessSummary?.RiskSummary) {
      try {
        const accessRiskData: AccessRiskItem[] = JSON.parse(accessSummary.RiskSummary);
        if (Array.isArray(accessRiskData) && accessRiskData.length > 0) {
          hasRisks = true;
          core.info(`Found ${accessRiskData.length} access risk assessment(s)`);
          resultSummary += `### 🛡️ Risk Assessment\n\n`;
          accessRiskData.forEach(risk => {
            const riskLevel = risk.riskAssessment?.riskLevel || 'Unknown';
            const riskEmoji = getSeverityEmoji(riskLevel);
            const principalDisplay = risk.principalId
              ? risk.principalId.split('/').pop()
              : 'Unknown Principal';
            const targets = risk.targetResources?.length
              ? risk.targetResources
              : risk.targetResource
                ? [risk.targetResource]
                : [];
            const targetDisplay =
              targets.length > 0
                ? targets.map(t => t.split('/').pop() ?? t).join(', ')
                : 'Unknown Resource';
            resultSummary += `#### ${riskEmoji} \`${principalDisplay}\` → \`${targetDisplay}\`\n\n`;
            resultSummary += `- **Principal**: \`${risk.principalId || 'Unknown'}\`\n`;
            resultSummary += `- **Target(s)**: \`${targetDisplay}\`\n`;
            resultSummary += `- **Risk Level**: **${riskLevel}**\n\n`;
            if (risk.riskAssessment?.issuesSummary) {
              resultSummary += `**Issues summary:**\n\n${risk.riskAssessment.issuesSummary}\n\n`;
            }
            if (risk.riskAssessment?.impactAssessment) {
              resultSummary += `**Impact:**\n\n${formatImpactAssessment(risk.riskAssessment.impactAssessment)}\n\n`;
            }
            if (
              risk.riskAssessment?.vulnerabilities &&
              risk.riskAssessment.vulnerabilities.length > 0
            ) {
              resultSummary += `\n**Vulnerabilities:**\n`;
              risk.riskAssessment.vulnerabilities.forEach(vuln => {
                const severityEmoji = getSeverityEmoji(vuln.severity);
                resultSummary += `- ${severityEmoji} **${vuln.cve || 'Unknown CVE'}** (${vuln.severity || 'Unknown'})\n`;
                if (vuln.riskAnalysis) resultSummary += `  - ${vuln.riskAnalysis}\n`;
              });
            }
            resultSummary += `\n`;
          });
        }
      } catch {
        core.warning(
          'Failed to parse AccessAnalysis.Summary.RiskSummary as JSON, skipping access risk details'
        );
      }
    }

    const statusEmoji = hasRisks ? '⚠️' : '✅';
    const statusText = hasRisks ? 'Security Issues Detected' : 'No Security Issues Detected';
    const detailsJson = JSON.stringify({ AccessAnalysis: parsedResult.AccessAnalysis }, null, 2);
    return buildCommentShell(
      COMMENT_MARKER_ACCESS,
      'Terraform Access Risk Analysis',
      statusEmoji,
      statusText,
      resultSummary,
      detailsJson,
      commitSha
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(`Failed to parse scan result for access: ${errorMessage}`);
    return buildCommentShell(
      COMMENT_MARKER_ACCESS,
      'Terraform Access Risk Analysis',
      '⚠️',
      'Security Issues Detected',
      `\n⚠️ Unable to parse the detailed results. Please check the raw output below.\n\n`,
      scanResult,
      commitSha
    );
  }
}

/**
 * Format the full scan result into a single combined PR comment (legacy).
 * Prefer posting two separate comments via formatReachabilityComment and formatAccessComment.
 */
export function formatScanResult(scanResult: string, commitSha: string): string {
  const reach = formatReachabilityComment(scanResult, commitSha);
  const access = formatAccessComment(scanResult, commitSha);
  return reach + '\n\n---\n\n' + access;
}

/**
 * Get emoji for risk/severity level
 * Works for both risk levels and vulnerability severity ratings
 *
 * @param level - Risk or severity level (critical, high, medium, low)
 * @returns Emoji representing the severity level
 */
function getSeverityEmoji(level?: string): string {
  switch (level?.toLowerCase()) {
    case 'critical':
      return '🔴';
    case 'high':
      return '🟠';
    case 'medium':
      return '🟡';
    case 'low':
      return '🟢';
    default:
      return '⚪';
  }
}

function hasReachabilityRisksInParsed(parsed: AnalyzeTerraformResult): boolean {
  const summaryData = parsed.ReachabilityAnalysis?.Summary;
  if (summaryData?.NewInternetExposures && summaryData.NewInternetExposures.length > 0) {
    return true;
  }
  if (summaryData?.RiskSummary) {
    try {
      const riskData = JSON.parse(summaryData.RiskSummary);
      if (Array.isArray(riskData) && riskData.length > 0) return true;
    } catch {
      if (summaryData.RiskSummary.trim().length > 0) return true;
    }
  }
  return false;
}

function hasAccessRisksInParsed(parsed: AnalyzeTerraformResult): boolean {
  const accessPermissions = parsed.AccessAnalysis?.AccessPermissions;
  if (accessPermissions && accessPermissions.length > 0) {
    for (const perm of accessPermissions) {
      if ((perm.Added && perm.Added.length > 0) || (perm.Removed && perm.Removed.length > 0)) {
        return true;
      }
    }
  }
  const accessRiskSummary = parsed.AccessAnalysis?.Summary?.RiskSummary;
  if (accessRiskSummary) {
    try {
      const accessRiskData = JSON.parse(accessRiskSummary);
      if (Array.isArray(accessRiskData) && accessRiskData.length > 0) return true;
    } catch {
      if (accessRiskSummary.trim().length > 0) return true;
    }
  }
  return false;
}

/** True if reachability analysis has any risks (exposures or risk summary). */
export function hasReachabilityRisks(scanResult: string): boolean {
  try {
    return hasReachabilityRisksInParsed(JSON.parse(scanResult));
  } catch {
    return true;
  }
}

/** True if access analysis has any risks (permission changes or risk summary). */
export function hasAccessRisks(scanResult: string): boolean {
  try {
    return hasAccessRisksInParsed(JSON.parse(scanResult));
  } catch {
    return true;
  }
}

/**
 * Check if the scan result has any risks (reachability or access).
 *
 * @param scanResult - JSON string containing the scan results
 * @returns True if risks are detected, false otherwise
 */
export function hasRisksInResult(scanResult: string): boolean {
  try {
    const parsed: AnalyzeTerraformResult = JSON.parse(scanResult);
    return hasReachabilityRisksInParsed(parsed) || hasAccessRisksInParsed(parsed);
  } catch {
    return true;
  }
}

async function postOrUpdateSingleComment(
  octokit: ReturnType<typeof github.getOctokit>,
  repo: { owner: string; repo: string },
  prNumber: number,
  marker: string,
  body: string,
  mode: CommentMode
): Promise<void> {
  if (mode === 'update') {
    try {
      const { data: comments } = await octokit.rest.issues.listComments({
        ...repo,
        issue_number: prNumber,
      });
      const existing = comments.find(c => c.body?.includes(marker));
      if (existing) {
        await octokit.rest.issues.updateComment({
          ...repo,
          comment_id: existing.id,
          body,
        });
        core.info(`✓ Updated existing comment (${marker})`);
        return;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to update comment (${marker}): ${msg}. Creating new.`);
    }
  }
  await octokit.rest.issues.createComment({
    ...repo,
    issue_number: prNumber,
    body,
  });
  core.info(`Created PR comment (${marker})`);
}

/**
 * Post or update two PR comments: one for reachability analysis, one for access analysis.
 *
 * @param token - GitHub token for authentication
 * @param scanResult - JSON string containing the scan results
 * @param commitSha - The commit SHA for which the scan was performed
 * @param mode - Comment mode: 'always', 'update', or 'on-security-risks'
 * @throws Never throws - errors are logged as warnings to avoid failing the action
 */
export async function postOrUpdateComment(
  token: string,
  scanResult: string,
  commitSha: string,
  mode: CommentMode
): Promise<void> {
  try {
    core.info('Preparing to post/update PR comments (reachability + access)...');
    const context = github.context;

    if (!context.payload.pull_request) {
      core.warning('Not in a pull request context. Skipping PR comment.');
      return;
    }

    let parsed: AnalyzeTerraformResult;
    try {
      parsed = JSON.parse(scanResult);
    } catch {
      core.warning('Failed to parse scan result. Skipping PR comments.');
      return;
    }

    const hasReachability = !!parsed.ReachabilityAnalysis;
    const hasAccess = !!parsed.AccessAnalysis;
    const shouldPostReachability =
      hasReachability && (mode !== 'on-security-risks' || hasReachabilityRisksInParsed(parsed));
    const shouldPostAccess =
      hasAccess && (mode !== 'on-security-risks' || hasAccessRisksInParsed(parsed));

    if (!shouldPostReachability && !shouldPostAccess) {
      core.info(
        'No reachability/access data to post or mode is on-security-risks with no risks. Skipping.'
      );
      return;
    }

    const octokit = github.getOctokit(token);
    const prNumber = context.payload.pull_request.number;
    const repo = context.repo;
    const serverUrl = (process.env['GITHUB_SERVER_URL'] || 'https://github.com').replace(
      /\/+$/,
      ''
    );
    const repository = process.env['GITHUB_REPOSITORY'] || `${repo.owner}/${repo.repo}`;
    const runId = process.env['GITHUB_RUN_ID'];
    const workflowRunUrl =
      runId && repository ? `${serverUrl}/${repository}/actions/runs/${runId}` : undefined;

    if (shouldPostReachability) {
      const commentBody = formatReachabilityComment(scanResult, commitSha);
      const finalBody = enforceCommentBodyLimit(
        commentBody,
        GITHUB_COMMENT_BODY_MAX_LENGTH,
        workflowRunUrl
      );
      if (finalBody.length < commentBody.length) {
        core.info(
          `Reachability comment truncated (${commentBody.length} → ${finalBody.length} chars)`
        );
      }
      await postOrUpdateSingleComment(
        octokit,
        repo,
        prNumber,
        COMMENT_MARKER_REACHABILITY,
        finalBody,
        mode
      );
    }

    if (shouldPostAccess) {
      const commentBody = formatAccessComment(scanResult, commitSha);
      const finalBody = enforceCommentBodyLimit(
        commentBody,
        GITHUB_COMMENT_BODY_MAX_LENGTH,
        workflowRunUrl
      );
      if (finalBody.length < commentBody.length) {
        core.info(`Access comment truncated (${commentBody.length} → ${finalBody.length} chars)`);
      }
      await postOrUpdateSingleComment(
        octokit,
        repo,
        prNumber,
        COMMENT_MARKER_ACCESS,
        finalBody,
        mode
      );
    }

    core.info('PR comments (reachability + access) completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(`Failed to post PR comments: ${errorMessage}`);
    core.warning('Continuing action despite PR comment failure');
  }
}
