/**
 * GitHub issue template for Terraform misconfiguration scan
 */

import type { TerraformResource } from '@averlon/shared';

export interface IssueTemplateData {
  batchNumber: number;
  totalBatches: number;
  resources: TerraformResource[];
  repoName: string;
  commit: string;
  issueIds: string[];
  workflowRunUrl?: string;
  gistUrl?: string;
}

const ISSUE_TEMPLATE_BODY = `
## Averlon Misconfiguration Remediation Agent for IaC

**Repository:** \`[REPO_NAME]\`
**Commit:** \`[COMMIT]\`
[BATCH_INFO]

### 📋 Security Findings

🔍 **Issue IDs:** [ISSUE_IDS]

**Summary:**

- Total resources scanned: [TOTAL_RESOURCES]
- Resources with issues: [RESOURCES_WITH_ISSUES]
- Unique issues found: [UNIQUE_ISSUES_COUNT]

[DETAILED_RESOURCES]

[GIST_LINK]

[WORKFLOW_RUN_NOTE]

---

### 📝 Next Steps

To get comprehensive remediation information for these issues:

**Use Averlon MCP tools** (averlon_get_ide_recommendation) with the above issue IDs to get:
   - Asset details and context
   - Misconfiguration information
   - Specific remediation strategies

---


_This issue was automatically created by Averlon Misconfiguration Remediation Agent for IaC._
`.trim();

/**
 * Generates issue title for a batch of Terraform resources
 */
export function generateIssueTitle(batchNumber: number, totalBatches: number): string {
  if (totalBatches > 1) {
    return `Averlon Misconfiguration Remediation Agent for IaC: Batch ${batchNumber} of ${totalBatches}`;
  }
  return `Averlon Misconfiguration Remediation Agent for IaC: Batch ${batchNumber}`;
}

/**
 * Generates a GitHub issue body using the embedded template
 */
export function generateIssueBody(data: IssueTemplateData): string {
  const {
    batchNumber,
    totalBatches,
    resources,
    repoName,
    commit,
    issueIds,
    workflowRunUrl,
    gistUrl,
  } = data;

  // Calculate summary statistics
  const totalResources = resources.length;
  const resourcesWithIssues = resources.filter(r => r.Issues && r.Issues.length > 0).length;
  const uniqueIssueCount = issueIds.length;

  // Build batch info line
  const batchInfo = totalBatches > 1 ? `**Batch:** ${batchNumber} of ${totalBatches}\n` : '';

  // Build issue IDs list
  const issueIdsText = issueIds.length > 0 ? issueIds.join(', ') : 'None';

  const workflowRunNote = workflowRunUrl
    ? `   - [View logs & artifacts](${workflowRunUrl})`
    : 'Workflow run: Logs & artifacts are available in the GitHub Actions run that generated this issue.';

  // Build Gist link section
  const gistLink = gistUrl
    ? `\n### 📄 Resources JSON\n\n📦 [View Resources JSON](${gistUrl})\n\nThis JSON file contains the complete Terraform resource data for this batch, including all resource details, issues, and metadata.\n`
    : '';

  // Build detailed resources section
  let detailedResources = '';
  if (resources.length > 0) {
    detailedResources += `\n### 📋 Resources in This Batch\n\n`;
    for (let i = 0; i < resources.length; i++) {
      const resource = resources[i];
      const resourceId = resource.ID || `resource-${i + 1}`;
      const resourceType = resource.Type || 'Unknown';
      const resourceName = resource.Name || 'Unknown';

      detailedResources += `#### Resource ${i + 1}: \`${resourceType}.${resourceName}\`\n\n`;
      detailedResources += `- **ID:** \`${resourceId}\`\n`;

      if (resource.Asset?.ID) {
        detailedResources += `- **Asset ID:** \`${resource.Asset.ID}\`\n`;
      }

      if (resource.Asset?.ResourceID) {
        detailedResources += `- **Resource ID:** \`${resource.Asset.ResourceID}\`\n`;
      }

      // List issues for this resource
      if (resource.Issues && resource.Issues.length > 0) {
        detailedResources += `- **Issues (${resource.Issues.length}):**\n`;
        for (const issue of resource.Issues) {
          if (issue.ID) {
            detailedResources += `  - Issue ID: \`${issue.ID}\`\n`;
          }
        }
      } else {
        detailedResources += `- **Issues:** None\n`;
      }

      // Reachability information if available
      if (resource.Reachability) {
        const reachability = resource.Reachability;
        if (reachability.IsReachableFromInternet !== undefined) {
          detailedResources += `- **Reachable from Internet:** ${
            reachability.IsReachableFromInternet ? 'Yes' : 'No'
          }\n`;
        }
        if (reachability.CanReachInternet !== undefined) {
          detailedResources += `- **Can reach Internet:** ${
            reachability.CanReachInternet ? 'Yes' : 'No'
          }\n`;
        }
      }

      detailedResources += `\n`;
    }
  }

  // Replace placeholders in the template
  const body = ISSUE_TEMPLATE_BODY.replace(/\[REPO_NAME\]/g, repoName)
    .replace(/\[COMMIT\]/g, commit)
    .replace(/\[BATCH_INFO\]/g, batchInfo)
    .replace(/\[ISSUE_IDS\]/g, issueIdsText)
    .replace(/\[TOTAL_RESOURCES\]/g, String(totalResources))
    .replace(/\[RESOURCES_WITH_ISSUES\]/g, String(resourcesWithIssues))
    .replace(/\[UNIQUE_ISSUES_COUNT\]/g, String(uniqueIssueCount))
    .replace('[DETAILED_RESOURCES]', detailedResources)
    .replace('[GIST_LINK]', gistLink)
    .replace('[WORKFLOW_RUN_NOTE]', workflowRunNote);

  return body;
}
