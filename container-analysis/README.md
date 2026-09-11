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
3. **Claude access** — either one:
   - **Anthropic API Key**: An API key from [Anthropic](https://console.anthropic.com/). Store it as a secret (e.g., `ANTHROPIC_API_KEY`).
   - **Amazon Bedrock**: Set `use-bedrock: true`, with AWS credentials and `AWS_REGION` in the workflow environment. See [Using Claude on Amazon Bedrock](#-using-claude-on-amazon-bedrock).
4. **GitHub Token**: Workflow `GITHUB_TOKEN` with `contents: write` and `pull-requests: write` permissions configured (see [permissions docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions))
5. **Container engine**: `docker` or `podman` must be available on the runner (`ubuntu-latest` includes docker by default). The action uses docker when it is present and podman otherwise. If the engine is installed outside `PATH`, give its path with the `container-engine` input.

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
        uses: averlon-ai/actions/container-analysis@v2.0.7
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
        uses: averlon-ai/actions/container-analysis@v2.0.7
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
        uses: averlon-ai/actions/container-analysis@v2.0.7
        with:
          averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
          averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          dockerfile: ${{ matrix.dockerfile }}
          image-repository: ${{ matrix.image-repository }}
```

## 📥 Inputs

| Input                | Description                                                                                                                                                                                                                                                                                                        | Required | Default                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------ |
| `averlon-api-key`    | API key for Averlon authentication (GitActions-scoped)                                                                                                                                                                                                                                                             | ✅       | -                              |
| `averlon-api-secret` | API secret for Averlon authentication (GitActions-scoped)                                                                                                                                                                                                                                                          | ✅       | -                              |
| `anthropic-api-key`  | API key for Anthropic. Not needed when `use-bedrock` is `true`                                                                                                                                                                                                                                                     | ❌       | -                              |
| `mcp-api-key`        | API key for Averlon MCP server (MCPClient-scoped)                                                                                                                                                                                                                                                                  | ✅       | -                              |
| `mcp-api-secret`     | API secret for Averlon MCP server (MCPClient-scoped)                                                                                                                                                                                                                                                               | ✅       | -                              |
| `github-token`       | GitHub token with `contents: write` and `pull-requests: write` permissions                                                                                                                                                                                                                                         | ✅       | -                              |
| `dockerfile`         | Path to the Dockerfile to remediate (e.g. `Dockerfile` or `api/Dockerfile`)                                                                                                                                                                                                                                        | ✅       | -                              |
| `image-repository`   | Image repository for the Dockerfile (e.g. `registry.io/org/app`)                                                                                                                                                                                                                                                   | ❌       | `''`                           |
| `base-url`           | Base URL for the Averlon API and MCP server                                                                                                                                                                                                                                                                        | ❌       | `https://wfe.prod.averlon.io/` |
| `filters`            | Comma-separated recommendation filters. Options: `Recommended`, `Exploited`, `Critical`, `High`, `HighRCE`, `Medium`, `MediumApplication`, `Low`, `LowApplication`                                                                                                                                                 | ❌       | `Recommended,Critical,HighRCE` |
| `disable-websearch`  | Disable the WebSearch tool                                                                                                                                                                                                                                                                                         | ❌       | `false`                        |
| `model`              | Claude model for remediation. Supported: `claude-opus-5` (recommended), `claude-opus-4-6`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`. Empty means `claude-opus-5`, or `us.anthropic.claude-opus-5` with `use-bedrock`. See [Claude models](https://platform.claude.com/docs/en/about-claude/models/overview). | ❌       | `''`                           |
| `use-bedrock`        | Run the Coding Agent against Claude on Amazon Bedrock instead of the Anthropic API. AWS credentials and `AWS_REGION` must be in the workflow environment.                                                                                                                                                          | ❌       | `false`                        |
| `container-engine`   | Command used to run the Averlon MCP server container, for runners that keep it outside `PATH` or under another name. A name on `PATH` (`docker`, `podman`) or an absolute path such as `/opt/podman/bin/podman`. Empty means docker if present, podman otherwise.                                                  | ❌       | `''`                           |

## 🚨 Troubleshooting

### Common Issues

**Issue: "The Anthropic API key was rejected (401)"**

The action validates `anthropic-api-key` against the Anthropic API before doing any other work, and fails immediately if the key is unusable.

- `401` — the key is invalid, expired, or revoked. Issue a new key and update the secret.
- `403` — the key is valid but not permitted to use the API. Check its workspace and permissions.
- `credit balance is too low` — the Anthropic account is out of credit. Top it up.
- No key provided — confirm the `ANTHROPIC_API_KEY` secret exists and is exposed to the workflow (secrets are not available to workflows triggered by forked PRs).

If Anthropic is unreachable or rate-limits the check, the action logs a warning and continues rather than failing. The key is also re-checked when the Coding Agent step fails, so a key that expires mid-run fails the action instead of passing silently.

**Issue: "No recommendations found"**

Averlon did not find any vulnerabilities matching your filters for the specified Dockerfile/image. This is normal if your image is already up to date.

- Verify the `dockerfile` input points to the correct file
- If using `image-repository`, ensure it matches the image registered in Averlon
- Try broadening your `filters` (e.g., `Recommended,Critical,High,Medium`)

**Issue: AI agent errors or fails to create a PR**

The agent may fail if the remediation is complex or the repository context is insufficient.

- Check the `prompt` output for what was sent to the agent
- Ensure the GitHub token has `contents: write` and `pull-requests: write` permissions
- Try a more capable model (e.g., `claude-opus-5`)
- The step uses `continue-on-error: true`, so the workflow won't fail — check step logs for details. The one exception is an unusable Anthropic API key: the key is re-validated after a failed agent run and the action fails if it has become invalid.

**Issue: MCP connection issues**

The MCP server runs as a container. If it fails to connect:

- Ensure `docker` or `podman` is available on the runner (`ubuntu-latest` includes docker by default)
- If the engine is installed outside `PATH`, set `container-engine` to its absolute path
- If using separate MCP credentials (`mcp-api-key` / `mcp-api-secret`), verify they have MCPClient scope
- Check that `base-url` is reachable from the runner

## ☁️ Using Claude on Amazon Bedrock

Set `use-bedrock: true` to run the Coding Agent against Claude on Bedrock, and leave `anthropic-api-key` unset.

The credentials have to be **in the environment** as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` for temporary credentials), or as `AWS_BEARER_TOKEN_BEDROCK`, and `AWS_REGION` must be set. An instance or pod IAM role on its own is **not** enough: `claude-code-action` checks those variables before it starts, so assume the role in a step such as `aws-actions/configure-aws-credentials` first. This action does not acquire credentials itself.

Leaving `model` unset gives `us.anthropic.claude-opus-5`. Setting it explicitly requires a Bedrock model or inference profile id, not an Anthropic model name:

```yaml
jobs:
  remediate:
    runs-on: self-hosted
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    env:
      AWS_REGION: us-west-2
    steps:
      - uses: actions/checkout@v5
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
          aws-region: us-west-2
      - uses: averlon-ai/actions/container-analysis@v2.0.7
        with:
          use-bedrock: true
          model: us.anthropic.claude-opus-4-5-20251101-v1:0
          averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
          averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
          mcp-api-key: ${{ secrets.AVERLON_MCP_API_KEY }}
          mcp-api-secret: ${{ secrets.AVERLON_MCP_API_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          dockerfile: Dockerfile
          image-repository: registry.io/org/app
```

The IAM role needs `bedrock:InvokeModelWithResponseStream` on the model you name — the agent streams, so a policy granting only `bedrock:InvokeModel` is not enough. With a `us.`/`global.` prefixed id, grant it on the inference profile ARN as well as the foundation model, and make sure model access is enabled in the account.

A role scoped to just that model is fine: the agent probes for a small, fast model at startup, and a denial there degrades to a warning instead of failing the run.

## 💡 Best Practices

1. **Use Specific Filters**: Start with `Recommended,Critical,HighRCE` (the default) and expand as needed
2. **Provide Image Repository**: Explicitly set `image-repository` for more accurate vulnerability matching
3. **Use Matrix Strategy**: For repos with multiple Dockerfiles, use a matrix strategy to remediate each one independently
4. **Schedule Regular Runs**: Use cron triggers to catch new vulnerabilities as they are disclosed
5. **Review PRs Carefully**: Always review automated PRs before merging
6. **Separate MCP Credentials**: Use dedicated MCPClient-scoped credentials for the MCP server when possible
