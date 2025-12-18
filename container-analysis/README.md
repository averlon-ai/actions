# Averlon Vulnerability Remediation Agent for Containers Action

Docker and container security analysis with vulnerability detection and remediation

## 🚀 What It Does

This action scans your repository's Dockerfiles to identify security vulnerabilities and provides actionable recommendations to fix them. It automatically:

- Discovers all Dockerfiles in your repository
- Maps Dockerfiles to their corresponding container image repositories (Averlon attempts automatic mapping, but explicit mapping via `image-map` is recommended)
- Analyzes images for security vulnerabilities using Averlon's scanning service
- Creates or updates GitHub issues with detailed security recommendations
- Optionally assigns issues to GitHub Copilot for automated fixes
- Manages issue lifecycle (closes issues when Dockerfiles are removed or vulnerabilities are resolved)

## 📋 Prerequisites

Before using this action, ensure you have:

1. **Averlon Account**: Sign up at [Averlon](https://averlon.io) to get your API credentials
2. **API Credentials**: Obtain your `api_key` and `api_secret` from the Averlon dashboard
3. **GitHub Token**: A GitHub token with permissions to create and manage issues and pull requests
   - For basic usage: Use `${{ secrets.GITHUB_TOKEN }}` with appropriate `permissions` declared in your workflow
   - For Copilot auto-assignment: **Required** - Use a Personal Access Token (PAT) with Copilot access (the default `GITHUB_TOKEN` does not support Copilot assignment)
4. **Dockerfiles**: At least one Dockerfile in your repository

## 🔐 Create Averlon API Keys and MCP Setup

For detailed instructions on creating API keys, please refer to our [API Key Setup Documentation](../docs/actions-api-setup.md).

For setting up the MCP server, please refer to our [MCP Setup Documentation](../docs/mcp-setup.md).

## 🛠️ Usage

### Basic Workflow

```yaml
name: Averlon Container Security Remediation
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch: {}
  schedule:
    # Run daily at 2 AM UTC
    - cron: '0 2 * * *'

jobs:
  container-security-remediation:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Run Averlon Remediation Agent for Containers
        uses: averlon-ai/actions/container-analysis@v1.0.2
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### With Explicit Image Mapping (Recommended)

While Averlon automatically attempts to map Dockerfiles to image repositories, **explicitly providing the mapping via `image-map` is recommended** for better accuracy and reliability.

```yaml
name: Averlon Container Security Remediation
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch: {}
  schedule:
    # Run daily at 2 AM UTC
    - cron: '0 2 * * *'

jobs:
  container-security-remediation:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Run Averlon Remediation Agent for Containers
        uses: averlon-ai/actions/container-analysis@v1.0.2
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          image-map: |
            Dockerfile=docker.io/username/repo-name
            backend/Dockerfile=account-id.dkr.ecr.us-west-2.amazonaws.com/repo-name
            frontend/Dockerfile.prod=ghcr.io/orgname/frontend-app
          filters: 'RecommendedOrExploited,Critical,High'
```

### With GitHub Copilot Auto-Assignment

To enable automatic assignment of security issues to GitHub Copilot, you **must use a Personal Access Token (PAT)** with Copilot access. The default `GITHUB_TOKEN` does not support Copilot auto-assignment.

**Setting up a PAT for Copilot:**

1. Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Create a token with the following permissions:
   - Repository access: Select your repositories
   - Permissions: `Contents` (read), `Issues` (read/write), `Pull requests` (read/write)
   - **Important**: Your account must have GitHub Copilot access enabled
3. Add the token as a repository secret (e.g., `COPILOT_PAT`)

```yaml
name: Averlon Container Security Remediation with Copilot
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch: {}
  schedule:
    # Run daily at 2 AM UTC
    - cron: '0 2 * * *'

jobs:
  container-security-remediation:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Run Averlon Remediation Agent for Containers
        uses: averlon-ai/actions/container-analysis@v1.0.2
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.COPILOT_PAT }} # PAT with Copilot access required
          auto-assign-copilot: 'true'
```

## 📥 Inputs

| Input                 | Description                                                                                                                                                                                                      | Required | Default                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------- |
| `api-key`             | Averlon API key for authentication                                                                                                                                                                               | ✅       | -                                         |
| `api-secret`          | Averlon API secret for authentication                                                                                                                                                                            | ✅       | -                                         |
| `github-token`        | GitHub token for creating/managing issues. Use `${{ secrets.GITHUB_TOKEN }}` with `permissions: issues: write` declared in your workflow. **For Copilot auto-assignment, a PAT with Copilot access is required** | ✅       | -                                         |
| `base-url`            | Base URL for the Averlon API service                                                                                                                                                                             | ❌       | `https://wfe.prod.averlon.io/`            |
| `image-map`           | Multiline mapping of Dockerfile paths to image repository names (format: `path=repository`). **Recommended**: While Averlon attempts automatic mapping, explicit mapping ensures accuracy                        | ❌       | -                                         |
| `filters`             | Comma-separated vulnerability filters: `RecommendedOrExploited`, `Critical`, `High`, `HighRCE`, `MediumApplication`                                                                                              | ❌       | `RecommendedOrExploited,Critical,HighRCE` |
| `auto-assign-copilot` | Auto-assign security issues to GitHub Copilot agent for automated fixes. **Requires a PAT with Copilot access**                                                                                                  | ❌       | `false`                                   |

## 📤 Outputs

This action provides outputs through GitHub's job summary feature:

- **Summary Table**: Lists all discovered Dockerfiles and their mapped image repositories
- **Security Issues**: Creates/updates GitHub issues labeled with `averlon-created` and `averlon-container-analysis` containing:
  - Dockerfile path
  - Image repository name
  - Detailed security recommendations
  - Fix suggestions

## 🔄 How It Works

1. **Discovery**: Scans your repository for Dockerfiles (supports `Dockerfile`, `*.dockerfile`, `Dockerfile.*` patterns)
2. **Mapping**: Maps discovered Dockerfiles to container image repositories:
   - Averlon automatically attempts to identify the image repository for each Dockerfile
   - You can explicitly provide mappings via the `image-map` input (recommended for accuracy)
   - Labels within Dockerfiles can also aid in mapping
3. **Scanning**: Sends Dockerfile metadata to Averlon's API for security analysis
4. **Filtering**: Applies configured filters to focus on critical vulnerabilities
5. **Issue Management**:
   - Creates new GitHub issues for security findings
   - Updates existing issues when recommendations change
   - Closes issues when Dockerfiles are removed or vulnerabilities are resolved
6. **Copilot Integration** (optional): Assigns issues to GitHub Copilot for automated fix generation (requires `auto-assign-copilot` enabled)
7. **Cleanup**: Removes orphaned issues for Dockerfiles that no longer exist

## 🚨 Troubleshooting

### Common Issues

**Issue: "Unable to map Dockerfile to image repository"**

While Averlon attempts to automatically map Dockerfiles to image repositories, this may fail if the relationship cannot be determined automatically. **Solution: Provide explicit image mapping** using the `image-map` input.

```yaml
# Solution: Provide explicit image mapping (recommended)
- name: Run Averlon Remediation Agent for Containers
  uses: averlon-ai/actions/container-analysis@v1.0.2
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    image-map: |
      Dockerfile=docker.io/username/repo-name
      services/api/Dockerfile=account-id.dkr.ecr.us-west-2.amazonaws.com/repo-name
```

**Best Practice**: Always provide explicit `image-map` configuration to ensure reliable mapping and avoid potential issues.

**Issue: "Copilot assignment failed"**

Copilot auto-assignment requires a Personal Access Token (PAT) with Copilot access. The default `GITHUB_TOKEN` does not support assigning issues to the Copilot agent.

```yaml
# Solution: Use a PAT with Copilot access
jobs:
  container-security-remediation:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Run Averlon Remediation Agent for Containers
        uses: averlon-ai/actions/container-analysis@v1.0.2
        with:
          api-key: ${{ secrets.AVERLON_API_KEY }}
          api-secret: ${{ secrets.AVERLON_API_SECRET }}
          github-token: ${{ secrets.COPILOT_PAT }} # Must be a PAT, not GITHUB_TOKEN
          auto-assign-copilot: 'true'
```

Ensure your PAT has:

- Repository access to your repos
- `Contents` (read), `Issues` (read/write), `Pull requests` (read/write) permissions
- Your GitHub account has Copilot access enabled

**Issue: "Too many low-priority findings"**

Adjust the filters to focus on critical vulnerabilities.

```yaml
# Solution: Use stricter filters
- name: Run Averlon Remediation Agent for Containers
  uses: averlon-ai/actions/container-analysis@v1.0.2
  with:
    api-key: ${{ secrets.AVERLON_API_KEY }}
    api-secret: ${{ secrets.AVERLON_API_SECRET }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    filters: 'Critical,HighRCE' # Only show critical and high-risk RCE vulnerabilities
```

## 💡 Best Practices

1. **Provide Explicit Image Mappings**: Always use `image-map` to explicitly map Dockerfiles to image repositories for reliable scanning
2. **Declare Proper Permissions**: Always specify `permissions` in your workflow to use `GITHUB_TOKEN` effectively
3. **Schedule Regular Scans**: Use cron triggers to scan your images regularly, not just on pushes
4. **Use Strict Filters in Production**: Start with `Critical,HighRCE` filters and expand as needed
5. **Leverage Copilot**: Enable `auto-assign-copilot` with a PAT to get automated fix suggestions
6. **Keep Mappings Updated**: Maintain your `image-map` configuration as your infrastructure evolves
