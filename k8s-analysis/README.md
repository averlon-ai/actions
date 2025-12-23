# Averlon Misconfiguration Remediation Agent for Kubernetes GitHub Action

Kubernetes Helm chart misconfiguration detection and remediation

## 🚀 What It Does

- Parses rendered Kubernetes manifests (Helm or plain YAML) for analysis
- Enriches resources with detected metadata (region, cluster, account ID, ARNs, labels/annotations)
- Queries Averlon for misconfiguration intelligence and best-practice gaps
- Creates or updates GitHub issues with remediation guidance
- Optionally assigns issues to GitHub Copilot for automated fixes

## 📋 Prerequisites

Before using this action, ensure you have:

1. **Averlon Account**: Sign up at [Averlon](https://averlon.io) to get your API credentials
2. **API Credentials**: Obtain your `api_key` and `api_secret` from the Averlon dashboard
3. **GitHub Token**:
   - Basic usage: workflow `GITHUB_TOKEN` with `issues: write`
   - Copilot auto-assignment: PAT with Copilot access
4. **Tools**:
   - `helm` only if generating manifests from Helm charts (not needed for plain YAML)
5. **Manifests**: Helm-rendered output or plain Kubernetes YAML

## 🔐 Create Averlon API Keys and MCP Setup

For detailed instructions on creating API keys, please refer to our [API Key Setup Documentation](../docs/actions-api-setup.md).

For setting up the MCP server, please refer to our [MCP Setup Documentation](../docs/mcp-setup.md).

## 🛠️ Usage

### With Helm Template (recommended)

```yaml
- name: Generate Helm manifests
  run: |
    helm template my-release ./charts/my-app \
      --namespace production \
      --values values.yaml > manifests.yaml

- name: Run Averlon Remediation Agent for Kubernetes
  uses: averlon-ai/actions/k8s-analysis@v1.0.3
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    manifest-file: manifests.yaml
```

### With Plain Kubernetes YAML

If you already have plain Kubernetes YAML files (not Helm charts), you can analyze them directly:

```yaml
- name: Bundle manifests
  run: |
    cat deployment.yaml service.yaml configmap.yaml > manifests.yaml

- name: Run Averlon Remediation Agent for Kubernetes
  uses: averlon-ai/actions/k8s-analysis@v1.0.3
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    manifest-file: manifests.yaml
    release-name: my-app
    namespace: default
```

> **Note:** `manifest-file` should point to a YAML file that may contain one or many Kubernetes resources separated by `---`.

## 🎯 Auto-Detection

The action automatically detects **region**, **cluster**, and **account ID** from multiple sources:

1. **Kubernetes labels** (`topology.kubernetes.io/region`, `topology.kubernetes.io/zone`)
2. **Chart-emitted values in manifests** (any labels/annotations your chart writes)
3. **Resource annotations** (`eks.amazonaws.com/cluster-name`, `aws.amazon.com/account-id`)
4. **Environment variables** (extracts ARNs and account IDs from env vars)

The action also extracts **comprehensive metadata** from every resource:

- ✅ Container images and names
- ✅ ConfigMap and Secret references
- ✅ Volume claims
- ✅ Service types and load balancer info
- ✅ All AWS ARNs in annotations and env vars
- ✅ Storage classes
- ✅ Replica counts

In most cases, you don't need to manually specify `region`, `cluster`, or `cloud-id` inputs!

## Input Parameters

| Input                  | Description                                                                                                                       | Required | Default                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| `api-key`              | Averlon API key                                                                                                                   | Yes      | -                              |
| `api-secret`           | Averlon API secret                                                                                                                | Yes      | -                              |
| `github-token`         | GitHub token for creating issues. Provide a PAT with Copilot access to enable assignment; otherwise uses workflow `GITHUB_TOKEN`. | No       | Workflow `GITHUB_TOKEN`        |
| `manifest-file`        | Path to the Helm manifests YAML file (one or more Kubernetes resources, separated by `---`).                                      | Yes      | -                              |
| `cloud-id`             | secdi Cloud ID for issue lookup. When omitted, the action discovers using detected account metadata.                              | No       | Auto-detected                  |
| `release-name`         | Override release name                                                                                                             | No       | -                              |
| `namespace`            | Override namespace                                                                                                                | No       | -                              |
| `filters`              | Comma-separated severity filters: Critical, High, Medium, Low                                                                     | No       | `Critical,High`                |
| `resource-type-filter` | Filter by resource types (comma-separated): Deployment,StatefulSet,etc.                                                           | No       | -                              |
| `namespace-filter`     | Filter by namespaces (comma-separated): default,production,etc.                                                                   | No       | -                              |
| `base-url`             | Averlon API base URL                                                                                                              | No       | `https://wfe.prod.averlon.io/` |

## How It Works

### 1. Generate Kubernetes Manifests

You have three options to generate manifests:

#### Option A: Using `helm template` (Recommended for Helm Charts)

```bash
helm template my-release ./charts/my-app \
  --namespace production \
  --values values.yaml
```

This prints the rendered Kubernetes YAML (multiple documents separated by `---`), which can be redirected straight to a file.

#### Option B: Using Plain Kubernetes YAML Files

If you already have plain Kubernetes YAML files (not from Helm), you can use them directly without `helm` commands:

```bash
# Single file
cat your-manifests.yaml

# Multiple files
cat deployment.yaml service.yaml

# All files in a directory
cat k8s-manifests/*.yaml
```

No Helm commands needed—just bundle your YAML into a single file and point `manifest-file` at it.

### 2. Bundle manifests into YAML

Regardless of how you generated the manifests, the action expects `manifest-file` to point to a YAML file that contains one or more Kubernetes resources separated by `---`. Use one of the following snippets:

**If you used `helm template`:**

```bash
helm template my-release ./charts/my-app \
  --namespace production \
  --values values.yaml > manifests.yaml
```

**If you have plain Kubernetes YAML files:**

```bash
# Single file
cp your-manifests.yaml manifests.yaml

# Multiple files
cat file1.yaml file2.yaml file3.yaml > manifests.yaml

# All YAML files in a directory
cat k8s/*.yaml > manifests.yaml
```

### 3. Analyze with Averlon

The action:

1. Parses the YAML resources
2. Extracts metadata (ARNs, namespaces, labels, annotations)
3. Queries Averlon API for known misconfigurations
4. Creates GitHub issues with findings
5. Optionally assigns to GitHub Copilot for auto-fixes

## Examples

### Basic Example

```yaml
name: Averlon Kubernetes Security Remediation

on:
  pull_request:
    branches: [main]

jobs:
  k8s-security-remediation:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Generate Helm manifests
        run: |
          helm template my-app ./charts/my-app \
            --namespace production \
            --values values.yaml > manifests.yaml

      - name: Run Averlon Remediation Agent for Kubernetes
        uses: averlon-ai/actions/k8s-analysis@v1.0.3
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          manifest-file: manifests.yaml
          cloud-id: ${{ secrets.AWS_ACCOUNT_ID }}
          namespace: production
          filters: Critical,High
```

## Plain Kubernetes YAML Analysis

Analyze plain Kubernetes manifests without Helm:

```yaml
name: Averlon Kubernetes Security Remediation

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  k8s-security-remediation:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Bundle Kubernetes YAML
        run: |
          # Combine all YAML files into a single multi-doc YAML file
          cat k8s-manifests/*.yaml > manifests.yaml

      - name: Run Averlon Remediation Agent for Kubernetes
        uses: averlon-ai/actions/k8s-analysis@v1.0.3
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          manifest-file: manifests.yaml
          release-name: k8s-app
          namespace: default
          filters: Critical,High
```

## Multi-Environment Analysis

Analyze multiple environments in parallel:

```yaml
jobs:
  analyze:
    strategy:
      matrix:
        environment: [dev, staging, prod]
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v6

      - name: Generate manifests for ${{ matrix.environment }}
        run: |
          helm template app-${{ matrix.environment }} ./chart \
            --namespace ${{ matrix.environment }} \
            --values values-${{ matrix.environment }}.yaml > manifests.yaml

      - name: Run Averlon Remediation Agent for Kubernetes
        uses: averlon-ai/actions/k8s-analysis@v1.0.3
        with:
          manifest-file: manifests.yaml
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          namespace: ${{ matrix.environment }}
```

## GitHub Copilot Integration

Enable automatic issue fixing with GitHub Copilot:

```yaml
- name: Run Averlon Remediation Agent for Kubernetes
  uses: averlon-ai/actions/k8s-analysis@v1.0.3
  with:
    manifest-file: manifests.yaml
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.COPILOT_PAT }} # Must be PAT with Copilot access
    filters: Critical,High
```

**Important:** Copilot assignment only occurs when you provide a `github-token` input that is a Personal Access Token (PAT) with GitHub Copilot access. When omitted, the action falls back to the workflow `GITHUB_TOKEN` and simply creates the tracking issue.

## Filters

Control which issues are reported:

### By Severity

- `Critical` - Critical severity issues
- `High` - High severity issues
- `Medium` - Medium severity issues
- `Low` - Low severity issues

### Examples

```yaml
# Only critical issues
filters: Critical

# Critical and high severity
filters: Critical,High

# Multiple filters
filters: Critical,High,Medium
```

### By Resource Type

Filter to only analyze specific Kubernetes resource types:

```yaml
# Only analyze Deployments
resource-type-filter: Deployment

# Multiple resource types
resource-type-filter: Deployment,StatefulSet,DaemonSet

# Focus on workload resources
resource-type-filter: Deployment,StatefulSet,DaemonSet,Job,CronJob
```

### By Namespace

Filter to only analyze resources in specific namespaces:

```yaml
# Only production namespace
namespace-filter: production

# Multiple namespaces
namespace-filter: production,staging

# Exclude default namespace by only including others
namespace-filter: kube-system,monitoring,logging
```

### Combined Filters Example

```yaml
- name: Analyze Production Workloads Only
  uses: averlon-ai/actions/k8s-analysis@v1.0.3
  with:
    manifest-file: manifests.yaml
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    # Severity filters
    filters: Critical,High
    # Only check deployments and statefulsets
    resource-type-filter: Deployment,StatefulSet
    # Only in production namespace
    namespace-filter: production
    cloud-id: ${{ secrets.AWS_ACCOUNT_ID }}
    region: us-west-2
    cluster: prod-cluster
```

## Outputs

| Output               | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `analysis-json`      | Compact JSON summary (chart, release, namespace, totals) |
| `analysis-json-path` | Path to the full `k8s-analysis-output.json` file         |

## Troubleshooting

### "No valid Kubernetes resources found"

**Cause:** The YAML doesn't contain valid Kubernetes resources.

**Solution:** Ensure each resource has `kind` and `apiVersion` fields:

```bash
# Quick check (first document)
awk 'BEGIN{RS="---"} NR==1 {print}' manifests.yaml
```

### "Invalid YAML format"

**Cause:** The input is not valid YAML.

**Solution:**

1. Validate the file locally:
   ```bash
   yamllint manifests.yaml
   ```
2. If using Helm, check the rendered output:
   ```bash
   helm template my-release ./chart --namespace production --values values.yaml > manifests.yaml
   ```

### Missing Cloud ID

**Cause:** Cloud ID not provided and not found in values.

**Solution:**

1. Add `cloud-id` input explicitly
2. Or include `account_id` in your `values.yaml`:
   ```yaml
   app:
     account_id: '123456789'
   ```

## Requirements

- **Helm 3.x** - Only required for Helm chart analysis; not needed for plain K8s YAML files
- **GitHub Actions runner** - ubuntu-latest, macos-latest, or windows-latest

## License

MIT

## Support

For issues or questions:

- GitHub Issues: [averlon-ai/actions](https://github.com/averlon-ai/actions/issues)
- Documentation: [Averlon Docs](https://docs.averlon.io)
