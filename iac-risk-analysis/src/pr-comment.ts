import * as core from '@actions/core';
import * as github from '@actions/github';
import type { AnalyzeTerraformResult, RiskAssessment } from '@averlon/shared';

export type CommentMode = 'always' | 'update' | 'on-security-risks';

/**
 * HTML comment marker used to identify Averlon scan comments for updates
 * This allows us to find and update existing comments instead of creating duplicates
 */
const COMMENT_MARKER = '<!-- averlon-terraform-scan-comment -->';

/**
 * Format the scan result into a readable PR comment
 *
 * This function parses the JSON scan results and formats them into a structured markdown
 * comment with sections for summary, internet exposures, risk assessments, and access risks.
 *
 * @param scanResult - JSON string containing the scan results from the API
 * @param commitSha - The commit SHA for which the scan was performed (for tracking)
 * @returns Formatted markdown string ready to be posted as a PR comment
 */
export function formatScanResult(scanResult: string, commitSha: string): string {
  let parsedResult: AnalyzeTerraformResult;
  let resultSummary = '';
  let hasRisks = false; // Track whether any risks were found

  try {
    core.debug(`Parsing scan result (length: ${scanResult.length} chars)`);
    parsedResult = JSON.parse(scanResult);

    // Handle Reachability section - use TerraformReachabilityAnalysis.Summary
    // This is accessed via ReachabilityResult.Summary (TerraformReachabilityAnalysisSummary)
    const summaryData = parsedResult.ReachabilityAnalysis?.Summary;

    if (summaryData) {
      core.debug('Found summary data in scan results');

      // === Text Summary Section ===
      // High-level overview of the scan findings
      if (summaryData.TextSummary) {
        core.debug('Adding text summary to comment');
        resultSummary += `### 📝 Summary\n\n${summaryData.TextSummary}\n\n`;
      }

      // === New Internet Exposures Section ===
      // Highlights resources that will become publicly accessible after this change
      if (summaryData.NewInternetExposures && summaryData.NewInternetExposures.length > 0) {
        hasRisks = true; // Any internet exposure is considered a risk
        core.info(`Found ${summaryData.NewInternetExposures.length} new internet exposure(s)`);
        resultSummary += `### 🌐 New Internet Exposures\n\n`;
        resultSummary += `The following resources will be exposed to the internet:\n\n`;
        summaryData.NewInternetExposures.forEach((resource, index) => {
          resultSummary += `${index + 1}. \`${resource}\`\n`;
        });
        resultSummary += `\n`;
      }

      // === Risk Summary Section ===
      // Detailed risk assessment for each affected resource
      if (summaryData.RiskSummary) {
        core.debug('Parsing risk summary data');
        try {
          const riskData: RiskAssessment[] = JSON.parse(summaryData.RiskSummary);
          if (Array.isArray(riskData) && riskData.length > 0) {
            hasRisks = true;
            core.info(`Found ${riskData.length} risk assessment(s)`);
            resultSummary += `### ⚠️ Risk Assessment\n\n`;
            riskData.forEach((risk, index) => {
              const riskLevel = risk.riskAssessment?.riskLevel || 'Unknown';
              const riskEmoji = getSeverityEmoji(riskLevel);

              core.debug(`Processing risk ${index + 1}: ${risk.terraformResource} (${riskLevel})`);

              resultSummary += `#### ${riskEmoji} Resource ${index + 1}: \`${risk.terraformResource || 'Unknown'}\`\n\n`;
              resultSummary += `- **Cloud Resource**: \`${risk.cloudResource || 'Unknown'}\`\n`;
              resultSummary += `- **Risk Level**: **${riskLevel}**\n`;

              // Add issues summary if available
              if (risk.riskAssessment?.issuesSummary) {
                resultSummary += `- **Issues**: ${risk.riskAssessment.issuesSummary}\n`;
              }

              // Add impact assessment if available
              if (risk.riskAssessment?.impactAssessment) {
                resultSummary += `- **Impact**: ${risk.riskAssessment.impactAssessment}\n`;
              }

              // === Vulnerabilities Subsection ===
              // List any known vulnerabilities (CVEs) associated with this resource
              if (
                risk.riskAssessment?.vulnerabilities &&
                risk.riskAssessment.vulnerabilities.length > 0
              ) {
                core.debug(
                  `Found ${risk.riskAssessment.vulnerabilities.length} vulnerabilities for resource ${index + 1}`
                );
                resultSummary += `\n**Vulnerabilities:**\n`;
                risk.riskAssessment.vulnerabilities.forEach(vuln => {
                  const severityEmoji = getSeverityEmoji(vuln.severity);
                  resultSummary += `- ${severityEmoji} **${vuln.cve || 'Unknown CVE'}** (${vuln.severity || 'Unknown'})\n`;
                  if (vuln.riskAnalysis) {
                    resultSummary += `  - ${vuln.riskAnalysis}\n`;
                  }
                });
              }
              resultSummary += `\n`;
            });
          }
        } catch {
          // Don't fail the entire comment if risk summary parsing fails
          // Fall back to displaying the raw risk summary as text
          core.warning('Failed to parse RiskSummary as JSON, displaying as text');
          resultSummary += `### ⚠️ Risk Assessment\n\n${summaryData.RiskSummary}\n\n`;
        }
      }
    } else {
      core.debug('No summary data found in scan results');
    }

    // TODO: ADD ACCESS RISK SUMMARY SECTION

    // // === Access Risk Summary Section ===
    // // IAM/Access control risks (who has access to what)
    // if (parsedResult.accessRiskSummary) {
    //   core.debug('Parsing access risk summary data');
    //   try {
    //     const riskAssessments: AccessRiskAssessment[] = JSON.parse(parsedResult.accessRiskSummary);
    //     if (Array.isArray(riskAssessments) && riskAssessments.length > 0) {
    //       hasRisks = true;
    //       core.info(`Found ${riskAssessments.length} access risk assessment(s)`);
    //       resultSummary += `### 🛡️ Access Risk Assessment\n\n`;

    //       riskAssessments.forEach((assessment, index) => {
    //         const riskLevel = assessment.riskAssessment?.riskLevel || 'Unknown';
    //         const riskEmoji = getSeverityEmoji(riskLevel);
    //         const principalId = assessment.principalId || 'Unknown Principal';
    //         const targetResource = assessment.targetResource || 'Unknown Resource';

    //         core.debug(
    //           `Processing access risk ${index + 1}: ${principalId} → ${targetResource} (${riskLevel})`
    //         );

    //         resultSummary += `#### ${riskEmoji} Assessment ${index + 1}\n\n`;
    //         // Extract just the last part of the ARN/path for readability
    //         resultSummary += `- **Principal**: \`${principalId.split('/').pop()}\`\n`;
    //         resultSummary += `- **Target Resource**: \`${targetResource.split('/').pop()}\`\n`;
    //         resultSummary += `- **Risk Level**: **${riskLevel}**\n`;

    //         if (assessment.riskAssessment?.issuesSummary) {
    //           resultSummary += `- **Issues**: ${assessment.riskAssessment.issuesSummary}\n`;
    //         }
    //         if (assessment.riskAssessment?.impactAssessment) {
    //           resultSummary += `- **Impact**: ${assessment.riskAssessment.impactAssessment}\n`;
    //         }

    //         // Vulnerabilities
    //         const vulnerabilities = assessment.riskAssessment?.vulnerabilities || [];
    //         const validVulnerabilities = vulnerabilities.filter(
    //           vuln => vuln.cve || vuln.severity || vuln.riskAnalysis
    //         );

    //         if (validVulnerabilities.length > 0) {
    //           resultSummary += `\n**Vulnerabilities:**\n`;
    //           validVulnerabilities.forEach(vuln => {
    //             const severityEmoji = getSeverityEmoji(vuln.severity);
    //             resultSummary += `- ${severityEmoji} **${vuln.cve || 'Unknown CVE'}** (${vuln.severity || 'Unknown'})\n`;
    //             if (vuln.riskAnalysis) {
    //               resultSummary += `  - ${vuln.riskAnalysis}\n`;
    //             }
    //           });
    //         }
    //         resultSummary += `\n`;
    //       });
    //     }
    //   } catch {
    //     // Fall back to displaying raw access risk summary if parsing fails
    //     core.warning('Failed to parse accessRiskSummary as JSON, displaying as code block');
    //     resultSummary += `### 🛡️ Access Risk Assessment\n\n\`\`\`\n${parsedResult.accessRiskSummary}\n\`\`\`\n\n`;
    //   }
    // }

    // === Generic Summary Section ===
    // Handle any additional summary data not covered by specific sections
    if (
      parsedResult.ReachabilityAnalysis?.Summary &&
      Object.keys(parsedResult.ReachabilityAnalysis?.Summary).length > 0
    ) {
      core.debug('Adding generic summary section');
      resultSummary += `### 📊 Summary\n\n`;
      resultSummary += Object.entries(parsedResult.ReachabilityAnalysis?.Summary)
        .map(([key, value]) => `- **${key}**: ${value}`)
        .join('\n');
      resultSummary += `\n\n`;
    }
  } catch (error) {
    // === Top-level Error Handling ===
    // If JSON parsing completely fails, show a fallback message
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(`Failed to parse scan result: ${errorMessage}`);
    core.debug(`Scan result that failed to parse: ${scanResult.substring(0, 500)}...`);
    resultSummary = `\n⚠️ Unable to parse the detailed results. Please check the raw output below.\n\n`;
    hasRisks = true; // Treat parse errors as requiring attention
  }

  // === Build Final Comment ===
  // Construct the complete markdown comment with header, content, and footer
  const statusEmoji = hasRisks ? '⚠️' : '✅';
  const statusText = hasRisks ? 'Security Issues Detected' : 'No Security Issues Detected';

  core.debug(`Comment status: ${statusText} (hasRisks: ${hasRisks})`);

  const commentBody = `${COMMENT_MARKER}
## ${statusEmoji} Terraform Security Analysis

**Status**: ${statusText}

${resultSummary || '*No significant changes detected.*'}

<details>
<summary>📋 Full Scan Results (Click to expand)</summary>

\`\`\`json
${scanResult}
\`\`\`

</details>

---
*Analysis performed on commit: \`${commitSha}\`*
*Powered by [Averlon Security](https://averlon.io)*
`;

  core.debug(`Generated comment body (length: ${commentBody.length} chars)`);
  return commentBody;
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

/**
 * Check if the scan result has any risks
 *
 * @param scanResult - JSON string containing the scan results
 * @returns True if risks are detected, false otherwise
 */
export function hasRisksInResult(scanResult: string): boolean {
  try {
    const parsed: AnalyzeTerraformResult = JSON.parse(scanResult);

    // Check for new internet exposures using TerraformReachabilityAnalysis.Summary
    const summaryData = parsed.ReachabilityAnalysis?.Summary;
    if (summaryData?.NewInternetExposures && summaryData.NewInternetExposures.length > 0) {
      return true;
    }

    // Check for risk summary
    if (summaryData?.RiskSummary) {
      try {
        const riskData = JSON.parse(summaryData.RiskSummary);
        if (Array.isArray(riskData) && riskData.length > 0) {
          return true;
        }
      } catch {
        // If it's a string with content, assume it's a risk
        return summaryData.RiskSummary.trim().length > 0;
      }
    }

    // TODO: ADD ACCESS RISK SUMMARY CHECK

    // // Check for access risk summary
    // if (parsed.accessRiskSummary) {
    //   try {
    //     const accessRisks = JSON.parse(parsed.accessRiskSummary);
    //     if (Array.isArray(accessRisks) && accessRisks.length > 0) {
    //       return true;
    //     }
    //   } catch {
    //     return parsed.accessRiskSummary.trim().length > 0;
    //   }
    // }

    return false;
  } catch {
    // If we can't parse, assume there might be risks to be safe
    return true;
  }
}

/**
 * Post or update a PR comment with the scan results
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
    core.info('Preparing to post/update PR comment...');
    const context = github.context;

    // === Context Validation ===
    // Ensure we're running in a pull request, not a push or other event
    if (!context.payload.pull_request) {
      core.warning('Not in a pull request context. Skipping PR comment.');
      return;
    }

    core.debug(`PR context detected: PR #${context.payload.pull_request.number}`);

    // === Mode-based Filtering ===
    // Check if we should skip commenting based on mode and results
    if (mode === 'on-security-risks' && !hasRisksInResult(scanResult)) {
      core.info('No risks detected and comment-mode is "on-security-risks". Skipping PR comment.');
      return;
    }

    // Initialize GitHub API client
    const octokit = github.getOctokit(token);
    const prNumber = context.payload.pull_request.number;
    const repo = context.repo;

    core.debug(`Repository: ${repo.owner}/${repo.repo}, PR: ${prNumber}`);

    // Format the scan results into a markdown comment
    const commentBody = formatScanResult(scanResult, commitSha);

    // === Update Mode: Find and update existing comment ===
    if (mode === 'update') {
      core.info('Attempting to find and update existing comment...');
      try {
        // Fetch all comments on the PR
        const { data: comments } = await octokit.rest.issues.listComments({
          ...repo,
          issue_number: prNumber,
        });

        core.debug(`Found ${comments.length} existing comments on PR`);

        // Find our comment using the unique marker
        const existingComment = comments.find(comment => comment.body?.includes(COMMENT_MARKER));

        if (existingComment) {
          // Update the existing comment in place
          core.info(`Updating existing comment (ID: ${existingComment.id})`);
          await octokit.rest.issues.updateComment({
            ...repo,
            comment_id: existingComment.id,
            body: commentBody,
          });
          core.info('✓ PR comment updated successfully');
          return;
        } else {
          // No existing comment found, will create a new one below
          core.info('No existing comment found, creating new comment...');
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        core.warning(
          `Failed to fetch or update existing comment: ${errorMessage}. Will create a new comment instead.`
        );
        // Fall through to create new comment
      }
    }

    // Create new comment (for 'always' mode or when no existing comment found in 'update' mode)
    core.info('Creating new PR comment');
    await octokit.rest.issues.createComment({
      ...repo,
      issue_number: prNumber,
      body: commentBody,
    });
    core.info('PR comment created successfully');
  } catch (error) {
    // Don't fail the action if commenting fails
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.error(`Failed to post PR comment: ${errorMessage}`);
    core.warning('Continuing action despite PR comment failure');
  }
}
