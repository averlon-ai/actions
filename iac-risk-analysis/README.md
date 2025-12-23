# Averlon Infrastructure Risk PreCog Agent Action

Proactive infrastructure risk prediction and security guardrails for IaC deployments

## 🚀 What It Does

The Averlon Infrastructure Risk PreCog Agent Action helps you understand the complete security impact of your infrastructure changes by:

- **🌐 Reachability Analysis**: Identifies new internet exposures and network connectivity changes
- **🛡️ Access Control Assessment**: Analyzes IAM permission changes and access risks
- **⚠️ Vulnerability Detection**: Identifies CVEs and security misconfigurations
- **📊 Comprehensive Reporting**: Provides detailed risk assessments with severity ratings
- **💬 PR Comments**: Automatically posts formatted security analysis to pull requests

## 📋 Prerequisites

Before using this action, ensure you have:

1. **Averlon Account**: Sign up at [Averlon](https://averlon.io) to get your API credentials
2. **API Credentials**: Obtain your `api_key` and `api_secret` from the Averlon dashboard
3. **Terraform Setup**: Terraform installed and configured in your workflow
4. **Terraform Files**: Both plan and graph files for base and head commits
5. **Git Access**: Ability to checkout different commits

## 🔐 Create Averlon API Keys

For detailed instructions on creating API keys, please refer to our [API Key Setup Documentation](../docs/actions-api-setup.md).

## 🛠️ Usage

### Basic Workflow

```yaml
name: Averlon IaC Risk Analysis
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  iac-risk-analysis:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # Required for posting PR comments
    steps:
      - name: Checkout code
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.5.0

      - name: Generate base Terraform plan and graph
        run: |
          git checkout ${{ github.event.pull_request.base.sha }}
          terraform init
          terraform plan -out=base-plan.tfplan
          terraform show -json base-plan.tfplan > base-plan.json
          terraform graph > base-graph.dot

      - name: Generate head Terraform plan and graph
        run: |
          git checkout ${{ github.event.pull_request.head.sha }}
          terraform init
          terraform plan -out=head-plan.tfplan
          terraform show -json head-plan.tfplan > head-plan.json
          terraform graph > head-graph.dot

      - name: Run Averlon IaC Risk Analysis
        uses: averlon-ai/actions/iac-risk-analysis@v1.0.3
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          repo-name: ${{ github.repository }}
          base-commit-hash: ${{ github.event.pull_request.base.sha }}
          head-commit-hash: ${{ github.event.pull_request.head.sha }}
          base-plan-path: './base-plan.json'
          head-plan-path: './head-plan.json'
          base-graph-path: './base-graph.dot'
          head-graph-path: './head-graph.dot'
          github-token: ${{ secrets.GITHUB_TOKEN }}
          # comment-on-pr: 'true'  # Default, can be omitted
          # comment-mode: 'update'  # Default: updates existing comment
```

The action will automatically post formatted security analysis to your PR.

### With Custom Processing

Process scan results programmatically using the `scan-result` output:

```yaml
- name: Run Averlon IaC Risk Analysis
  id: analysis
  uses: averlon-ai/actions/iac-risk-analysis@v1.0.3
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    repo-name: ${{ github.repository }}
    base-commit-hash: ${{ github.event.pull_request.base.sha }}
    head-commit-hash: ${{ github.event.pull_request.head.sha }}
    base-plan-path: './base-plan.json'
    head-plan-path: './head-plan.json'
    base-graph-path: './base-graph.dot'
    head-graph-path: './head-graph.dot'
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: Process scan results
  run: |
    # Parse with jq
    echo '${{ steps.analysis.outputs.scan-result }}' | jq '.ReachabilityResult'

    # Send to monitoring system
    curl -X POST https://your-monitoring.com/api/scans \
      -H "Content-Type: application/json" \
      -d '${{ steps.analysis.outputs.scan-result }}'

    # Save as artifact
    echo '${{ steps.analysis.outputs.scan-result }}' > scan-result.json

- name: Upload results
  uses: actions/upload-artifact@v4
  with:
    name: terraform-scan-results
    path: scan-result.json
```

### With PR Comments Disabled

Disable automatic PR comments if you only need the output:

```yaml
- name: Run Averlon IaC Risk Analysis
  id: analysis
  uses: averlon-ai/actions/iac-risk-analysis@v1.0.3
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    repo-name: ${{ github.repository }}
    base-commit-hash: ${{ github.event.pull_request.base.sha }}
    head-commit-hash: ${{ github.event.pull_request.head.sha }}
    base-plan-path: './base-plan.json'
    head-plan-path: './head-plan.json'
    base-graph-path: './base-graph.dot'
    head-graph-path: './head-graph.dot'
    comment-on-pr: 'false' # Disable automatic PR comments

- name: Process scan results
  run: |
    echo "Scan result: ${{ steps.analysis.outputs.scan-result }}"
    # Process the results as needed
```

### With Advanced Configuration

```yaml
- name: Run Averlon IaC Risk Analysis
  uses: averlon-ai/actions/iac-risk-analysis@v1.0.3
  with:
    # Required inputs
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    repo-name: ${{ github.repository }}
    base-commit-hash: ${{ github.event.pull_request.base.sha }}
    head-commit-hash: ${{ github.event.pull_request.head.sha }}
    base-plan-path: './base-plan.json'
    head-plan-path: './head-plan.json'
    base-graph-path: './base-graph.dot'
    head-graph-path: './head-graph.dot'

    # Optional: PR commenting
    github-token: ${{ secrets.GITHUB_TOKEN }}
    comment-on-pr: 'true'
    comment-mode: 'update' # 'always', 'update', or 'on-security-risks'

    # Optional: Scan configuration
    scan-poll-interval: '45' # Poll every 45 seconds
    scan-timeout: '3600' # 1 hour timeout for large infrastructure
    base-url: 'https://wfe.prod.averlon.io/' # Custom API endpoint
```

**Comment Modes:**

- `always`: Creates a new comment on every run
- `update` (default): Updates the existing comment if found, otherwise creates new
- `on-security-risks`: Only comments when security risks are detected

````

## 📥 Inputs

### Required Inputs

| Input              | Description                                 |
| ------------------ | ------------------------------------------- |
| `api-key`          | Averlon API key ID for authentication       |
| `api-secret`       | Averlon API secret for HMAC signatures      |
| `repo-name`        | Name of the repository                      |
| `base-commit-hash` | Base commit hash for comparison             |
| `head-commit-hash` | Head commit hash for comparison             |
| `base-plan-path`   | Path to Terraform plan file for base state  |
| `head-plan-path`   | Path to Terraform plan file for head state  |
| `base-graph-path`  | Path to Terraform graph file for base state |
| `head-graph-path`  | Path to Terraform graph file for head state |

### Optional Inputs

| Input                | Description                                                                                  | Default                        |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| `base-url`           | Base URL for Averlon API                                                                     | `https://wfe.prod.averlon.io/` |
| `scan-poll-interval` | Polling interval in seconds for scan result checking                                         | `30`                           |
| `scan-timeout`       | Maximum timeout in seconds to wait for scan completion                                       | `1800`                         |
| `comment-on-pr`      | Whether to automatically comment analysis results on PR                                      | `true`                         |
| `github-token`       | GitHub token for posting PR comments (required if `comment-on-pr` is `true`)                 | `''`                           |
| `comment-mode`       | Comment mode: `always` (new each time), `update` (update existing), `on-security-risks` (if risks) | `update`                       |

## 📤 Outputs

| Output        | Description                                              |
| ------------- | -------------------------------------------------------- |
| `scan-result` | Complete JSON scan result with reachability impact analysis |

**Example**:
```yaml
- name: Run Averlon IaC Risk Analysis
  id: analysis
  uses: averlon-ai/actions/iac-risk-analysis@v1.0.3
  # ... inputs

- name: Use output
  run: echo '${{ steps.analysis.outputs.scan-result }}' | jq '.ReachabilityResult.Summary'
```

## 🔄 How It Works

The action follows this workflow:

1. **File Upload**: Uploads Terraform plan and graph files for both base and head commits
2. **Scan Initiation**: Starts a reachability analysis job on the Averlon platform
3. **Polling**: Monitors scan progress with configurable polling intervals
4. **Results**: Sets the complete scan results to `scan-result` output
5. **PR Comment** (optional): If enabled, posts formatted security analysis to the pull request

### PR Comment Format

When enabled, the action posts a formatted comment to your PR with:

- **📝 Summary**: High-level overview of the analysis
- **🌐 New Internet Exposures**: Resources being exposed to the internet
- **⚠️ Risk Assessment**: Detailed risk analysis for each affected resource
- **🛡️ Access Risk Assessment**: IAM and access control risk analysis
- **Vulnerability Details**: CVEs and security issues with severity ratings
- **Full JSON Results**: Expandable section with complete scan data

The comment updates automatically on new commits (in `update` mode) to keep your PR clean.

## 🚨 Troubleshooting

### Common Issues

**Authentication Errors**

```yaml
# Ensure your secrets are properly configured
api-key: ${{ secrets.AVERLON_API_KEY }} # Must be set in repository secrets
api-secret: ${{ secrets.AVERLON_API_SECRET }} # Must be set in repository secrets
````

**PR Comment Permission Errors**

If you see "Resource not accessible by integration" errors:

```yaml
jobs:
  iac-risk-analysis:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # This is required!
    steps:
      # ... your steps
```

Or disable PR commenting if you don't need it:

```yaml
with:
  comment-on-pr: 'false'
```

**File Not Found Errors**

```yaml
# Ensure Terraform files exist before running the action
- name: Check files exist
  run: |
    ls -la ./terraform/base-plan.json
    ls -la ./terraform/head-plan.json
    ls -la ./terraform/base-graph.dot
    ls -la ./terraform/head-graph.dot
```

**Timeout Issues**

```yaml
# Increase timeout for large infrastructure
scan-timeout: '3600' # 1 hour instead of default 30 minutes
```

### Debug Mode

Enable debug logging for troubleshooting:

```yaml
- name: Run Averlon IaC Risk Analysis
  uses: averlon-ai/actions/iac-risk-analysis@v1.0.3
  env:
    ACTIONS_STEP_DEBUG: true
  with:
    # ... your inputs
```

## 📊 Output Examples

The action returns a JSON result with reachability analysis:

```json
{
  "scanId": "scan-12345",
  "status": "completed",
  "reachabilityImpact": {
    "affectedResources": ["aws_instance.web", "aws_security_group.web"],
    "connectivityChanges": [
      {
        "resource": "aws_instance.web",
        "change": "modified",
        "reachabilityImpact": "medium"
      }
    ],
    "recommendations": ["Review security group changes for potential connectivity issues"]
  }
}
```

## 🔧 Local Testing

Test the action locally:

```bash
# Set environment variables
export INPUT_API_KEY="your-test-api-key"
export INPUT_API_SECRET="your-test-api-secret"
export INPUT_REPO_NAME="test-repo"
export INPUT_BASE_COMMIT_HASH="abc123"
export INPUT_HEAD_COMMIT_HASH="def456"
export INPUT_BASE_PLAN_PATH="./test/test-data/base-plan.json"
export INPUT_HEAD_PLAN_PATH="./test/test-data/head-plan.json"
export INPUT_BASE_GRAPH_PATH="./test/test-data/base-graph.dot"
export INPUT_HEAD_GRAPH_PATH="./test/test-data/head-graph.dot"

# Run the action
bun run dev
```
