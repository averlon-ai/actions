# Averlon Misconfiguration Remediation Agent for Kubernetes GitHub Action

Kubernetes Helm chart misconfiguration detection and remediation

## 🚀 What It Does

- Converts rendered Kubernetes manifests (Helm or plain YAML) into a JSON array
- Enriches resources with detected metadata (region, cluster, account ID, ARNs, labels/annotations)
- Queries Averlon for misconfiguration intelligence and best-practice gaps
- Creates or updates GitHub issues with remediation guidance
- Optionally assigns issues to GitHub Copilot for automated fixes

## 📋 Prerequisites

1. **Averlon account & API credentials**: `AVERLON_API_KEY`, `AVERLON_API_SECRET`
2. **GitHub token**:
   - Basic usage: workflow `GITHUB_TOKEN` with `issues: write`
   - Copilot auto-assignment: PAT with Copilot access
3. **Tools**:
   - `yq` for YAML → JSON
   - `jq` recommended for formatting
   - `helm` only if generating manifests from Helm charts (not needed for plain YAML)
4. **Manifests**: Helm-rendered output or plain Kubernetes YAML that you can convert to JSON

## Quick Start

### Using `helm install --dry-run`

```yaml
- name: Generate Helm manifests as JSON
  run: |
    helm install my-release ./charts/my-app \
      --dry-run \
      --namespace production \
      --values values.yaml | \
      sed -n '/^MANIFEST:/,$p' | tail -n +2 | \
      yq eval -o=json '.' - | jq -s '.' > manifests.json

- name: Analyze with Averlon
  uses: averlon-ai/actions/k8s-analysis@v1
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    manifest-file: manifests.json
```

### Using `helm template`

```yaml
- name: Generate Helm manifests as JSON
  run: |
    helm template my-release ./charts/my-app \
      --namespace production \
      --values values.yaml | \
      yq eval -o=json '.' - | jq -s '.' > manifests.json

- name: Analyze with Averlon
  uses: averlon-ai/actions/k8s-analysis@v1
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    manifest-file: manifests.json
```

### Using Plain Kubernetes YAML Files (No Helm)

If you have plain Kubernetes YAML files (not Helm charts), you can analyze them directly:

```yaml
- name: Convert K8s YAML to JSON
  run: |
    yq eval -o=json 'path/to/your/manifests.yaml' | jq -s '.' > manifests.json

- name: Analyze with Averlon
  uses: averlon-ai/actions/k8s-analysis@v1
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    manifest-file: manifests.json
    release-name: my-app
    namespace: default
```

**For multiple YAML files:**

```yaml
- name: Convert multiple K8s YAML files to JSON
  run: |
    cat deployment.yaml service.yaml configmap.yaml | \
      yq eval -o=json '.' - | jq -s '.' > manifests.json
```

**For a directory of YAML files:**

```yaml
- name: Convert all YAML files in directory to JSON
  run: |
    cat k8s-manifests/*.yaml | \
      yq eval -o=json '.' - | jq -s '.' > manifests.json
```

> **Note:** `manifest-file` can be a single Kubernetes object **or** a JSON array of objects. The conversion snippets above emit an array so you can pass multiple resources at once; single-object JSON also works if you only have one manifest.

## 🎯 Auto-Detection

The action automatically detects **region**, **cluster**, and **account ID** from multiple sources:

1. **Kubernetes labels** (`topology.kubernetes.io/region`, `topology.kubernetes.io/zone`)
2. **Helm values** (`app.region`, `app.cluster`, `app.account_id` in USER-SUPPLIED VALUES)
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
| `manifest-file`        | Path to the Helm manifests JSON file (an array of Kubernetes resources as shown above).                                           | Yes      | -                              |
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

This prints the rendered Kubernetes YAML (multiple documents separated by `---`), which can be piped directly into the JSON conversion step.

#### Option B: Using `helm install --dry-run`

```bash
helm install my-release ./charts/my-app \
  --dry-run \
  --namespace production \
  --values values.yaml
```

This simulates a full installation and outputs release metadata, user-supplied values, and a `MANIFEST` section. Because of the extra headings, you need to strip everything before `MANIFEST:` prior to converting to JSON.

#### Option C: Using Plain Kubernetes YAML Files

If you already have plain Kubernetes YAML files (not from Helm), you can use them directly without `helm` commands:

```bash
# Single file
cat your-manifests.yaml

# Multiple files
cat deployment.yaml service.yaml

# All files in a directory
cat k8s-manifests/*.yaml
```

No Helm commands needed—just convert to JSON as shown in step 2.

### 2. Convert to a JSON array

Regardless of how you generated the manifests, the action expects `manifest-file` to contain a JSON array where each entry is a Kubernetes resource with `kind` and `apiVersion`. Use one of the following conversion snippets:

**If you used `helm install --dry-run`:**

```bash
helm install my-release ./charts/my-app \
  --dry-run \
  --namespace production \
  --values values.yaml | \
  sed -n '/^MANIFEST:/,$p' | tail -n +2 | \
  yq eval -o=json '.' - | jq -s '.' > manifests.json
```

**If you used `helm template`:**

```bash
helm template my-release ./charts/my-app \
  --namespace production \
  --values values.yaml | \
  yq eval -o=json '.' - | jq -s '.' > manifests.json
```

**If you have plain Kubernetes YAML files:**

```bash
# Single file
yq eval -o=json 'your-manifests.yaml' | jq -s '.' > manifests.json

# Multiple files
cat file1.yaml file2.yaml file3.yaml | yq eval -o=json '.' - | jq -s '.' > manifests.json

# All YAML files in a directory
cat k8s/*.yaml | yq eval -o=json '.' - | jq -s '.' > manifests.json
```

### 3. Analyze with Averlon

The action:

1. Parses the JSON array of Kubernetes resources
2. Extracts metadata (ARNs, namespaces, labels, annotations)
3. Queries Averlon API for known misconfigurations
4. Creates GitHub issues with findings
5. Optionally assigns to GitHub Copilot for auto-fixes

## Examples

### Basic Example

```yaml
name: Helm Security Analysis

on:
  pull_request:
    branches: [main]

jobs:
  analyze:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Install yq
        run: |
          sudo wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq
          sudo chmod +x /usr/bin/yq

      - name: Generate Helm manifests
        run: |
          helm template my-app ./charts/my-app \
            --namespace production \
            --values values.yaml \
             > dry-run.txt

          # Extract MANIFEST and convert to JSON
          sed -n '/^MANIFEST:/,$p' dry-run.txt | \
            tail -n +2 | \
            yq eval -o=json '.' - | \
            jq -s '.' > manifests.json

      - name: Analyze with Averlon
        uses: averlon-ai/actions/k8s-analysis@v1
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          manifest-file: manifests.json
          cloud-id: ${{ secrets.AWS_ACCOUNT_ID }}
          namespace: production
          filters: Critical,High
```

## Plain Kubernetes YAML Analysis

Analyze plain Kubernetes manifests without Helm:

```yaml
name: K8s Security Analysis

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  analyze:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Install yq and jq
        run: |
          sudo wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq
          sudo chmod +x /usr/bin/yq
          sudo apt-get update && sudo apt-get install -y jq

      - name: Convert K8s YAML to JSON
        run: |
          # Combine all YAML files and convert to JSON array
          cat k8s-manifests/*.yaml | \
            yq eval -o=json '.' - | \
            jq -s '.' > manifests.json

      - name: Analyze with Averlon
        uses: averlon-ai/actions/k8s-analysis@v1
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          manifest-file: manifests.json
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

      - name: Install yq
        run: |
          sudo wget https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -O /usr/bin/yq
          sudo chmod +x /usr/bin/yq

      - name: Generate manifests for ${{ matrix.environment }}
        run: |
          helm template app-${{ matrix.environment }} ./chart \
            --namespace ${{ matrix.environment }} \
            --values values-${{ matrix.environment }}.yaml \
             | \
            sed -n '/^MANIFEST:/,$p' | tail -n +2 | \
            yq eval -o=json '.' - | jq -s '.' > manifests.json

      - name: Analyze
        uses: averlon-ai/actions/k8s-analysis@v1
        with:
          manifest-file: manifests.json
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          namespace: ${{ matrix.environment }}
```

## GitHub Copilot Integration

Enable automatic issue fixing with GitHub Copilot:

```yaml
- name: Analyze and Auto-fix
  uses: averlon-ai/actions/k8s-analysis@v1
  with:
    manifest-file: manifests.json
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
  uses: averlon-ai/actions/k8s-analysis@v1
  with:
    manifest-file: manifests.json
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

**Cause:** The JSON doesn't contain valid Kubernetes resources.

**Solution:** Ensure each resource has `kind` and `apiVersion` fields:

```bash
# Verify your JSON
cat manifests.json | jq '.[0] | {kind, apiVersion, metadata}'
```

### "Invalid JSON format"

**Cause:** The input is not valid JSON.

**Solution:**

1. Check your conversion pipeline:
   ```bash
   helm template ...  | \
     sed -n '/^MANIFEST:/,$p' | tail -n +2 | \
     yq eval -o=json '.' - | jq '.'
   ```
2. Verify output is valid JSON: `cat manifests.json | jq '.'`

### "No MANIFEST section found"

**Cause:** Using `helm install --dry-run` output but the MANIFEST section is missing or incorrectly parsed.

**Solution:**

1. If using Helm, ensure you're using the correct command:
   - `helm template` (no MANIFEST section, pipes directly)
   - `helm install --dry-run` (has MANIFEST section, needs `sed` to extract)
2. If using plain YAML files, skip the `sed` step entirely:
   ```bash
   cat your-file.yaml | yq eval -o=json '.' - | jq -s '.' > manifests.json
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

- **yq 4.x** - Required for all workflows
- **jq** - Optional, for formatting (recommended)
- **Helm 3.x** - Only required for Helm chart analysis; not needed for plain K8s YAML files
- **GitHub Actions runner** - ubuntu-latest, macos-latest, or windows-latest

## License

MIT

## Support

For issues or questions:

- GitHub Issues: [averlon-ai/actions](https://github.com/averlon-ai/actions/issues)
- Documentation: [Averlon Docs](https://docs.averlon.io)
