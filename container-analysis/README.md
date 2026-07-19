# Averlon Vulnerability Remediation Agent for Containers

Docker and container security analysis with vulnerability detection and remediation.

## 🚀 What It Does

This action detects and automatically remediates Dockerfile security vulnerabilities using Averlon's intelligence, then opens pull requests with the fixes applied.

## 📋 Prerequisites

Before using this action, ensure you have:

1. **Averlon Account**: Sign up at [Averlon](https://averlon.io) to get your API credentials
2. **Averlon API Credentials** — this action requires **two** key pairs from the Averlon dashboard (requires Averlon admin access; ask an Averlon org admin to create them if you don't have admin access):
   - **GitActions-scoped** (`averlon-api-key` / `averlon-api-secret`): Used by the action to fetch vulnerability data. Store as `AVERLON_API_KEY` and `AVERLON_API_SECRET`.
   - **MCPClient-scoped** (`mcp-api-key` / `mcp-api-secret`): Used by the MCP server for real-time vulnerability context. Store as `AVERLON_MCP_API_KEY` and `AVERLON_MCP_API_SECRET`.
3. **Anthropic API Key**: An API key from [Anthropic](https://console.anthropic.com/). Store it as a secret (e.g., `ANTHROPIC_API_KEY`).
4. **GitHub Token**: Workflow `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` permissions configured (see [permissions docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions))
5. **Docker**: Docker must be available on the runner (default on `ubuntu-latest`)

## 🔐 Create Averlon API Keys and MCP Setup

For detailed instructions on creating API keys, please refer to our [API Key Setup Documentation](../docs/actions-api-setup.md).

## 🛠️ Usage

### Basic Workflow

```yaml
name: Averlon Container Analysis
on:
  push:
    branches: [main]
  workflow_dispatch: {}
  schedule:
    - cron: '0 2 * * *'

jobs:
  remediate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Run Averlon Container Analysis
        uses: averlon-ai/actions/container-analysis@v2.0.3
        with:
          averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
          averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
          mcp-api-key: ${{ secrets.AVERLON_MCP_API_KEY }}
          mcp-api-secret: ${{ secrets.AVERLON_MCP_API_SECRET }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          dockerfile: Dockerfile
```

### Advanced Workflow with Optional Inputs

```yaml
name: Averlon Container Analysis
on:
  workflow_dispatch: {}
  schedule:
    - cron: '0 2 * * *'

jobs:
  remediate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Run Averlon Container Analysis
        uses: averlon-ai/actions/container-analysis@v2.0.3
        with:
          averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
          averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          dockerfile: api/Dockerfile
          image-repository: registry.io/org/api
          mcp-api-key: ${{ secrets.AVERLON_MCP_API_KEY }}
          mcp-api-secret: ${{ secrets.AVERLON_MCP_API_SECRET }}
          filters: 'Recommended,Critical,High'
          model: claude-sonnet-4-6
          disable-websearch: 'true'
```

### Matrix Strategy for Multiple Dockerfiles

```yaml
jobs:
  remediate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    strategy:
      matrix:
        include:
          - dockerfile: Dockerfile
            image-repository: registry.io/org/app
          - dockerfile: api/Dockerfile
            image-repository: registry.io/org/api
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Run Averlon Container Analysis
        uses: averlon-ai/actions/container-analysis@v2.0.3
        with:
          averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
          averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          dockerfile: ${{ matrix.dockerfile }}
          image-repository: ${{ matrix.image-repository }}
```

## 📥 Inputs

| Input                | Description                                                                                                                                                                                                        | Required | Default                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------ |
| `averlon-api-key`    | API key for Averlon authentication (GitActions-scoped)                                                                                                                                                             | ✅       | -                              |
| `averlon-api-secret` | API secret for Averlon authentication (GitActions-scoped)                                                                                                                                                          | ✅       | -                              |
| `anthropic-api-key`  | API key for Anthropic                                                                                                                                                                                              | ✅       | -                              |
| `mcp-api-key`        | API key for Averlon MCP server (MCPClient-scoped)                                                                                                                                                                  | ✅       | -                              |
| `mcp-api-secret`     | API secret for Averlon MCP server (MCPClient-scoped)                                                                                                                                                               | ✅       | -                              |
| `github-token`       | GitHub token with `contents: write` and `pull-requests: write` permissions                                                                                                                                         | ✅       | -                              |
| `dockerfile`         | Path to the Dockerfile to remediate (e.g. `Dockerfile` or `api/Dockerfile`)                                                                                                                                        | ✅       | -                              |
| `image-repository`   | Image repository for the Dockerfile (e.g. `registry.io/org/app`)                                                                                                                                                   | ❌       | `''`                           |
| `base-url`           | Base URL for the Averlon API and MCP server                                                                                                                                                                        | ❌       | `https://wfe.prod.averlon.io/` |
| `filters`            | Comma-separated recommendation filters. Options: `Recommended`, `Exploited`, `Critical`, `High`, `HighRCE`, `Medium`, `MediumApplication`, `Low`, `LowApplication`                                                 | ❌       | `Recommended,Critical,HighRCE` |
| `disable-websearch`  | Disable the WebSearch tool                                                                                                                                                                                         | ❌       | `false`                        |
| `model`              | Claude model for remediation. Supported: `claude-opus-4-6` (recommended), `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. See [Claude models](https://platform.claude.com/docs/en/about-claude/models/overview). | ❌       | `claude-opus-4-6`              |

## 🚨 Troubleshooting

### Common Issues

**Issue: "No recommendations found"**

Averlon did not find any vulnerabilities matching your filters for the specified Dockerfile/image. This is normal if your image is already up to date.

- Verify the `dockerfile` input points to the correct file
- If using `image-repository`, ensure it matches the image registered in Averlon
- Try broadening your `filters` (e.g., `Recommended,Critical,High,Medium`)

**Issue: AI agent errors or fails to create a PR**

The agent may fail if the remediation is complex or the repository context is insufficient.

- Check the `prompt` output for what was sent to the agent
- Ensure the GitHub token has `contents: write` and `pull-requests: write` permissions
- Try a more capable model (e.g., `claude-opus-4-6`)
- The step uses `continue-on-error: true`, so the workflow won't fail — check step logs for details

**Issue: MCP connection issues**

The MCP server runs as a Docker container. If it fails to connect:

- Ensure Docker is available on the runner (`ubuntu-latest` includes Docker by default)
- If using separate MCP credentials (`mcp-api-key` / `mcp-api-secret`), verify they have MCPClient scope
- Check that `base-url` is reachable from the runner

## 💡 Best Practices

1. **Use Specific Filters**: Start with `Recommended,Critical,HighRCE` (the default) and expand as needed
2. **Provide Image Repository**: Explicitly set `image-repository` for more accurate vulnerability matching
3. **Use Matrix Strategy**: For repos with multiple Dockerfiles, use a matrix strategy to remediate each one independently
4. **Schedule Regular Runs**: Use cron triggers to catch new vulnerabilities as they are disclosed
5. **Review PRs Carefully**: Always review automated PRs before merging
6. **Separate MCP Credentials**: Use dedicated MCPClient-scoped credentials for the MCP server when possible
