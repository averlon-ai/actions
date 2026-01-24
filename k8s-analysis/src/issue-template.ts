/**
 * GitHub issue template for Helm security findings
 */

import type { ParsedResource } from './resource-parser';
import { extractImageIssuesForDisplay } from './opensearch-issues';

export interface IssueTemplateData {
  chartName: string;
  releaseName: string;
  namespace: string;
  issueIds: string[];
  totalResources: number;
  resourcesWithIssues: number;
  resources: ParsedResource[];
  workflowRunUrl?: string;
  artifactsUrl?: string;
}

const ISSUE_TEMPLATE_BODY = `
## Averlon Misconfiguration Remediation Agent for Kubernetes

**Chart:** \`[CHART_NAME]\`
**Release Name:** \`[RELEASE_NAME]\`
**Namespace:** \`[NAMESPACE]\`

### 📋 Security Findings

🔍 **Issue IDs:** [ISSUE_ID_1], [ISSUE_ID_2], [ISSUE_ID_3]

**Summary:**

- Total resources scanned: [COUNT]
- Resources with issues: [RESOURCES_WITH_ISSUES]
- Unique issues found: [UNIQUE_ISSUES_COUNT]

[IMAGE_ISSUES_SECTION]

### ⚠️ Important: Sidecar Component Evaluation

Before proceeding with any remediation, you must carefully evaluate whether this misconfiguration involves a "sidecar" component. Sidecar components are third-party or open-source plugins that run alongside your main application containers. Common examples include:

- Monitoring agents (cwagent, prometheus, datadog-agent, etc.)
- Service mesh components (istio, linkerd, consul, etc.)
- Network plugins (calico, cilium, weave, etc.)
- Logging agents (fluentd, fluent-bit, logstash, etc.)
- Security tools (falco, twistlock, aqua, etc.)

**CRITICAL RULE:** If the misconfiguration is security-related AND the target resource is a sidecar component, you MUST research and consult the official best practices and documentation for that specific component before making any changes. Making security configuration changes to sidecar components without understanding their best practices can break the component's functionality or compromise the security posture.

---

To get comprehensive remediation information for these issues:

1. **Download artifacts** from this workflow run:
[HELM_OUTPUT_BULLET]
[CONSOLIDATED_ISSUES_BULLET]

2. **Use Averlon MCP tools** (averlon_get_ide_recommendation) with the above issue IDs to get:
   - Asset details and context
   - Misconfiguration information
   - Specific remediation strategies

[WORKFLOW_RUN_NOTE]

---

_This issue was automatically created by Averlon Helm analysis._
`.trim();

/**
 * Generates a GitHub issue body using the embedded template
 */
export function generateIssueBody(data: IssueTemplateData): string {
  const {
    chartName,
    releaseName,
    namespace,
    issueIds,
    totalResources,
    resourcesWithIssues,
    resources,
    workflowRunUrl,
    artifactsUrl,
  } = data;

  const helmOutputBullet = artifactsUrl
    ? `   - [\`k8s-analysis-output.json\`](${artifactsUrl}) - Full analysis results`
    : '   - `k8s-analysis-output.json` - Full analysis results (see workflow artifacts tab)';

  const consolidatedIssuesBullet = artifactsUrl
    ? `   - [\`consolidated-issues.json\`](${artifactsUrl}) - Detailed issue information`
    : '   - `consolidated-issues.json` - Detailed issue information (see workflow artifacts tab)';

  const workflowRunNote = workflowRunUrl
    ? `Workflow run: [View logs & artifacts](${workflowRunUrl})`
    : 'Workflow run: Logs & artifacts are available in the GitHub Actions run that generated this issue.';

  // Extract image issues for display
  const imageIssuesSection = buildImageIssuesSection(resources);

  // Replace placeholders in the template
  const body = ISSUE_TEMPLATE_BODY.replace(/\[CHART_NAME\]/g, chartName)
    .replace(/\[RELEASE_NAME\]/g, releaseName)
    .replace(/\[NAMESPACE\]/g, namespace)
    .replace(/\[COUNT\]/g, String(totalResources))
    .replace(/\[RESOURCES_WITH_ISSUES\]/g, String(resourcesWithIssues))
    .replace(/\[UNIQUE_ISSUES_COUNT\]/g, String(issueIds.length))
    .replace(
      /\[ISSUE_ID_1\], \[ISSUE_ID_2\], \[ISSUE_ID_3\]/g,
      issueIds.length > 0 ? issueIds.join(', ') : 'None'
    )
    .replace('[IMAGE_ISSUES_SECTION]', imageIssuesSection)
    .replace('[HELM_OUTPUT_BULLET]', helmOutputBullet)
    .replace('[CONSOLIDATED_ISSUES_BULLET]', consolidatedIssuesBullet)
    .replace('[WORKFLOW_RUN_NOTE]', workflowRunNote);

  return body;
}

/**
 * Generates issue title
 */
export function generateIssueTitle(chartName: string): string {
  return `Averlon Misconfiguration Remediation Agent for Kubernetes: ${chartName}`;
}

/**
 * Builds the image issues section for the GitHub issue body
 */
function buildImageIssuesSection(resources: ParsedResource[]): string {
  const imageIssuesMap = extractImageIssuesForDisplay(resources);

  if (imageIssuesMap.size === 0) {
    return '';
  }

  const imageIssueIds: string[] = [];
  const imageToResourcesMap = new Map<string, string[]>();

  for (const data of imageIssuesMap.values()) {
    if (data.issues.length === 0) {
      continue;
    }

    // Collect issue IDs
    for (const issue of data.issues) {
      if (issue.id) {
        imageIssueIds.push(issue.id);
      }
    }

    // Map images to resources
    const resourceList = data.resources.map(r => `${r.kind}/${r.namespace}/${r.name}`);
    for (const image of data.images) {
      const existing = imageToResourcesMap.get(image) || [];
      imageToResourcesMap.set(image, [...new Set([...existing, ...resourceList])]);
    }
  }

  if (imageIssueIds.length === 0) {
    return '';
  }

  const lines: string[] = [
    '### 🐳 Container Image Issues',
    '',
    `🔍 **Image Issue IDs:** ${imageIssueIds.join(', ')}`,
    '',
    '**Images used:**',
  ];

  for (const image of Array.from(imageToResourcesMap.keys()).sort()) {
    const resourcesForImage = imageToResourcesMap.get(image) || [];
    lines.push(`- \`${image}\` (used in: ${resourcesForImage.join(', ')})`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Example output for reference:
 *
 * ## Averlon Misconfiguration Remediation Agent for Kubernetes
 *
 * **Chart:** `secdi`
 * **Release:** `secdi-dev`
 * **Namespace:** `secdi`
 *
 * 🔍 **Issue IDs:** 559611281342989079, 554783555570369265, 606039870044898261
 *
 * **Summary:**
 * - Total resources scanned: 77
 * - Resources with issues: 15
 * - Unique issues found: 3
 *
 * ---
 *
 * ### 📋 Detailed Information
 *
 * To get comprehensive remediation information for these issues:
 *
 * 1. **Download artifacts** from this workflow run:
 *    - `k8s-analysis-output.json` - Full analysis results
 *    - `consolidated-issues.json` - Detailed issue information
 *
 * 2. **Use Averlon tools** with the above issue IDs to get:
 *    - Asset details and context
 *    - Misconfiguration information
 *    - Specific remediation strategies
 *
 * ---
 * *This issue was automatically created by Averlon Misconfiguration Remediation Agent for Kubernetes.*
 */
