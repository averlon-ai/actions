# Averlon Misconfiguration Remediation Agent for IaC Action

Security analysis for Terraform infrastructure changes with misconfiguration detection and remediation

## 🚀 What It Does

The Averlon Misconfiguration Remediation Agent for IaC Action helps you identify security issues in your Terraform infrastructure by:

- **🔍 Misconfiguration Detection**: Scans Terraform plans for security misconfigurations and compliance violations
- **⚠️ Issue Identification**: Identifies specific security issues and policy violations in your infrastructure
- **📊 Issue Reporting**: Provides detailed issue IDs and resource information
- **📝 GitHub Issues**: Automatically creates GitHub issues for resources with misconfigurations (batched 10 resources per issue)
- **🤖 Copilot Integration**: Optionally assigns GitHub Copilot to issues for automated remediation
- **🔄 Continuous Monitoring**: Integrates seamlessly into your CI/CD pipeline

## 📋 Prerequisites

Before using this action, ensure you have:

1. **Averlon Account**: Sign up at [Averlon](https://averlon.io) to get your API credentials
2. **API Credentials**: Obtain your `api_key` and `api_secret` from the Averlon dashboard
3. **Terraform Setup**: Terraform installed and configured in your workflow
4. **Terraform Plan File**: A JSON-formatted Terraform plan file to scan
5. **GitHub Token**: A GitHub token with permissions to create and manage issues
   - For basic usage: Use `${{ secrets.GITHUB_TOKEN }}` with appropriate `permissions` declared in your workflow
   - For Copilot auto-assignment: **Optional** - Use a Personal Access Token (PAT) with Copilot access (the default `GITHUB_TOKEN` does not support Copilot assignment)

## 🔐 Create Averlon API Keys and MCP Setup

For detailed instructions on creating API keys, please refer to our [API Key Setup Documentation](../docs/actions-api-setup.md).

For setting up the MCP server, please refer to our [MCP Setup Documentation](../docs/mcp-setup.md).

## 🛠️ Usage

### Basic Workflow

```yaml
name: Averlon IaC Misconfiguration Remediation
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  iac-misconfiguration-remediation:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write # Required for creating GitHub issues
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.5.0

      - name: Generate Terraform plan
        run: |
          terraform init
          terraform plan -out=tfplan
          terraform show -json tfplan > plan.json

      - name: Run Averlon Remediation Agent for IaC Misconfigurations
        uses: averlon-ai/actions/iac-misconfig-analysis@v1.0.2
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          commit: ${{ github.event.pull_request.head.sha }}
          plan-path: './plan.json'
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The action will automatically create GitHub issues for resources with misconfigurations, batching 10 resources per issue.

### With Custom Processing

Process scan results programmatically using the `scan-result` output:

```yaml
- name: Run Averlon Remediation Agent for IaC Misconfigurations
  id: scan
  uses: averlon-ai/actions/iac-misconfig-analysis@v1.0.2
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    commit: ${{ github.event.pull_request.head.sha }}
    plan-path: './plan.json'
    github-token: ${{ secrets.GITHUB_TOKEN }}

- name: Process scan results
  run: |
    # Parse scan results (JSON array of TerraformResource objects)
    echo '${{ steps.scan.outputs.scan-result }}' | jq '.'

    # Check if resources with issues were found
    RESOURCES='${{ steps.scan.outputs.scan-result }}'
    RESOURCE_COUNT=$(echo "$RESOURCES" | jq 'length')
    if [ "$RESOURCE_COUNT" -gt 0 ]; then
      echo "Found $RESOURCE_COUNT resources with security issues!"
      # Count total issues
      ISSUE_COUNT=$(echo "$RESOURCES" | jq '[.[] | .Issues // [] | length] | add')
      echo "Total issues found: $ISSUE_COUNT"
    fi

    # Send to monitoring system
    curl -X POST https://your-monitoring.com/api/scans \
      -H "Content-Type: application/json" \
      -d "$RESOURCES"

    # Save as artifact
    echo '${{ steps.scan.outputs.scan-result }}' > scan-result.json

- name: Upload results
  uses: actions/upload-artifact@v4
  with:
    name: terraform-scan-results
    path: scan-result.json
```

### With Issue Creation Disabled

Skip GitHub issue creation if you only need the output:

```yaml
- name: Run Averlon Remediation Agent for IaC Misconfigurations
  id: scan
  uses: averlon-ai/actions/iac-misconfig-analysis@v1.0.2
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    commit: ${{ github.event.pull_request.head.sha }}
    plan-path: './plan.json'
    # Omit github-token to skip issue creation

- name: Process scan results
  run: |
    echo "Resources: ${{ steps.scan.outputs.scan-result }}"
    # Process the results as needed
```

### With Advanced Configuration

```yaml
- name: Run Averlon Remediation Agent for IaC Misconfigurations
  uses: averlon-ai/actions/iac-misconfig-analysis@v1.0.2
  with:
    # Required inputs
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    commit: ${{ github.event.pull_request.head.sha }}
    plan-path: './plan.json'

    # Optional: GitHub issues creation
    github-token: ${{ secrets.GITHUB_TOKEN }} # Creates issues when provided

    # Optional: Scan configuration
    scan-poll-interval: '45' # Poll every 45 seconds
    scan-timeout: '3600' # 1 hour timeout for large infrastructure
    base-url: 'https://wfe.prod.averlon.io/' # Custom API endpoint
```

**GitHub Issues:**

- Issues are automatically created for resources with misconfigurations
- Resources are batched into groups of 10 per issue
- Issues are labeled with `averlon-terraform` for easy filtering
- If a GitHub token with Copilot access is provided, issues can be automatically assigned to Copilot for remediation

## 📥 Inputs

### Required Inputs

| Input        | Description                                    |
| ------------ | ---------------------------------------------- |
| `api-key`    | Averlon API key ID for authentication          |
| `api-secret` | Averlon API secret for HMAC signatures         |
| `commit`     | Commit SHA to scan                             |
| `plan-path`  | Path to the JSON-formatted Terraform plan file |

### Optional Inputs

| Input                | Description                                                                                                                       | Default                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `base-url`           | Base URL for Averlon API                                                                                                          | `https://wfe.prod.averlon.io/` |
| `scan-poll-interval` | Polling interval in seconds for scan result checking                                                                              | `30`                           |
| `scan-timeout`       | Maximum timeout in seconds to wait for scan completion                                                                            | `1800` (30 minutes)            |
| `github-token`       | GitHub token for creating issues. Provide a PAT with Copilot access to enable automated assignment; otherwise uses workflow token | `''` (optional)                |

## 📤 Outputs

| Output        | Description                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `scan-result` | JSON stringified array of `TerraformResource` objects found during the scan |

**Example**:

```yaml
- name: Run Averlon Remediation Agent for IaC Misconfigurations
  id: scan
  uses: averlon-ai/actions/iac-misconfig-analysis@v1.0.2
  # ... inputs

- name: Use output
  run: |
    RESOURCES='${{ steps.scan.outputs.scan-result }}'
    echo "Found resources: $RESOURCES"
    RESOURCE_COUNT=$(echo "$RESOURCES" | jq 'length')
    if [ "$RESOURCE_COUNT" -gt 0 ]; then
      echo "Security issues detected in $RESOURCE_COUNT resources!"
    fi
```

The `scan-result` output is a JSON stringified array of `TerraformResource` objects, for example:

```json
[
  {
    "ID": "resource-1",
    "Type": "aws_s3_bucket",
    "Name": "my-bucket",
    "Asset": {
      "ID": "asset-123",
      "ResourceID": "arn:aws:s3:::my-bucket"
    },
    "Issues": [
      {
        "ID": "issue-abc123",
        "OrgID": "org-123",
        "CloudID": "cloud-456"
      }
    ]
  }
]
```

## 🔄 How It Works

The action follows this workflow:

1. **File Upload**: Uploads the Terraform plan file to the Averlon platform
2. **Scan Initiation**: Starts a misconfiguration scan job for the specified commit
3. **Polling**: Monitors scan progress with configurable polling intervals and exponential backoff
4. **Results Extraction**: Extracts Terraform resources and their associated issues from the scan results
5. **Output**: Sets the JSON stringified array of resources to the `scan-result` output
6. **GitHub Issues Creation** (optional): If `github-token` is provided, creates GitHub issues for resources with misconfigurations

### GitHub Issues Format

When `github-token` is provided, the action automatically creates GitHub issues:

- **📝 Batching**: Resources are grouped into batches of 10 per issue
- **🏷️ Labeling**: All issues are labeled with `averlon-terraform` for easy filtering
- **📊 Issue Content**: Each issue includes:
  - Repository and commit information
  - Summary statistics (total resources, resources with issues, unique issue IDs)
  - Detailed resource information (ID, type, name, asset details)
  - Issue IDs for each resource
  - Reachability information (when available)
  - Next steps for remediation
- **🔄 Updates**: Existing issues are updated if the batch content changes
- **🧹 Cleanup**: Orphaned issues (from removed batches) are automatically closed
- **🤖 Copilot**: Issues can be automatically assigned to GitHub Copilot if a PAT with Copilot access is provided

## 🚨 Troubleshooting

### Common Issues

**Authentication Errors**

```yaml
# Ensure your secrets are properly configured
api-key: ${{ secrets.AVERLON_API_KEY }} # Must be set in repository secrets
api-secret: ${{ secrets.AVERLON_API_SECRET }} # Must be set in repository secrets
```

**GitHub Issues Permission Errors**

If you see "Resource not accessible by integration" errors:

```yaml
jobs:
  iac-misconfiguration-remediation:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write # This is required for creating issues!
    steps:
      # ... your steps
```

Or omit the `github-token` input if you don't need issue creation:

```yaml
with:
  # ... other inputs
  # Omit github-token to skip issue creation
```

**File Not Found Errors**

```yaml
# Ensure Terraform plan file exists before running the action
- name: Check plan file exists
  run: |
    ls -la ./plan.json
    # Verify the file is valid JSON
    cat ./plan.json | jq .
```

**Timeout Issues**

```yaml
# Increase timeout for large infrastructure
scan-timeout: '3600' # 1 hour instead of default 30 minutes
scan-poll-interval: '60' # Poll every 60 seconds for large scans
```

**Invalid Poll Configuration**

The `scan-timeout` must be greater than `scan-poll-interval`:

```yaml
# ❌ Invalid - timeout is less than poll interval
scan-poll-interval: '60'
scan-timeout: '30'

# ✅ Valid - timeout is greater than poll interval
scan-poll-interval: '30'
scan-timeout: '1800'
```

### Debug Mode

Enable debug logging for troubleshooting:

```yaml
- name: Run Averlon Remediation Agent for IaC Misconfigurations
  uses: averlon-ai/actions/iac-misconfig-analysis@v1.0.2
  env:
    ACTIONS_STEP_DEBUG: true
  with:
    # ... your inputs
```

## 📊 Output Examples

The action returns a JSON stringified array of `TerraformResource` objects:

**Resources with issues:**

```json
[
  {
    "ID": "resource-1",
    "Type": "aws_s3_bucket",
    "Name": "my-bucket",
    "Asset": {
      "ID": "asset-123",
      "ResourceID": "arn:aws:s3:::my-bucket"
    },
    "Issues": [
      {
        "ID": "issue-abc123",
        "OrgID": "org-123",
        "CloudID": "cloud-456"
      },
      {
        "ID": "issue-def456",
        "OrgID": "org-123",
        "CloudID": "cloud-456"
      }
    ]
  },
  {
    "ID": "resource-2",
    "Type": "aws_ec2_instance",
    "Name": "my-instance",
    "Asset": {
      "ID": "asset-456",
      "ResourceID": "arn:aws:ec2:us-east-1:123456789012:instance/i-123456"
    },
    "Issues": [
      {
        "ID": "issue-ghi789",
        "OrgID": "org-123",
        "CloudID": "cloud-456"
      }
    ]
  }
]
```

**No issues found:**

```json
[]
```

## 🔧 Local Testing

Test the action locally:

```bash
# Set environment variables
export INPUT_API_KEY="your-test-api-key"
export INPUT_API_SECRET="your-test-api-secret"
export INPUT_REPO_NAME="test-repo"
export INPUT_COMMIT="abc123"
export INPUT_PLAN_PATH="./test/plan.json"
export INPUT_SCAN_POLL_INTERVAL="30"
export INPUT_SCAN_TIMEOUT="1800"
export INPUT_GITHUB_TOKEN="test-token"
export GITHUB_REPOSITORY="test-owner/test-repo"

# Run the action
bun run dev
```
