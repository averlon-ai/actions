# Averlon Misconfiguration Remediation Agent for IaC

Finds the resources in your Terraform plan (or Pulumi stack) that have misconfigurations Averlon already found in your live cloud, and gets them fixed in your IaC code.

## 🚀 What It Does

The action reads the plan, finds the cloud resource ID of each resource, and correlates the resources with the misconfiguration issues that Averlon found in the cloud. Then it remediates them in one of two modes:

|                   | Copilot mode (default)                                                                 | Claude mode                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Select with       | `agent-mode: copilot`                                                                  | `agent-mode: claude`                                                                                                   |
| What happens      | The action creates GitHub issues, 10 resources per issue, for the GitHub Copilot agent | Claude Code runs in your workflow, fixes the Terraform code and opens pull requests                                    |
| Result            | Issues labeled `averlon-iac-misconfiguration-analysis`, optionally assigned to Copilot | Pull requests labeled `averlon-iac-misconfiguration-analysis`, and a Fixed or NoFix result for each finding in Averlon |
| IaC               | Terraform or Pulumi                                                                    | Terraform                                                                                                              |
| Workflow triggers | Any                                                                                    | `workflow_dispatch`, `schedule`, `workflow_run`                                                                        |

The action does not upload the plan. It sends the cloud resource IDs from the plan to Averlon. In Claude mode, Claude Code gets the plan address of each resource (for example `module.storage.aws_s3_bucket.logs`), not the plan.

## 📋 Requirements

| Requirement                                                                      | Copilot mode                                                                                                                                                            | Claude mode                                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Averlon **GitActions**-scoped key pair (`averlon-api-key`, `averlon-api-secret`) | Required                                                                                                                                                                | Required                                                                                                                      |
| Averlon **MCPClient**-scoped key pair                                            | Optional. Set it in the Copilot settings of the repository, so that Copilot can use the Averlon tools ([MCP setup](../docs/mcp-setup.md)). Not an input of this action. | Required, as `mcp-api-key` and `mcp-api-secret` (see [MCP keys](#mcp-keys))                                                   |
| Claude access                                                                    | Not used                                                                                                                                                                | `anthropic-api-key`, or Claude on Amazon Bedrock with `use-bedrock: true`                                                     |
| `github-token`                                                                   | Optional. Without it, the action creates no issues and only sets the `scan-result` output. `auto-assign-copilot` needs a PAT with Copilot access.                       | Required                                                                                                                      |
| Workflow `permissions`                                                           | `contents: read`, `issues: write`, `pull-requests: read`                                                                                                                | `contents: write`, `pull-requests: write`, `issues: read`                                                                     |
| Averlon cloud                                                                    | `cloud-id` or `account-id`. Without one, the action finds no misconfigurations.                                                                                         | `cloud-id` or `account-id`. Without one, the action fails.                                                                    |
| Plan                                                                             | Terraform plan JSON (`plan-path`), or Pulumi stack export (`pulumi-stack-path`)                                                                                         | Terraform plan JSON (`plan-path`)                                                                                             |
| Runner                                                                           | Node.js 20 or later on `PATH`, and bash                                                                                                                                 | Node.js 20 or later on `PATH`, bash, and docker or podman. Terraform on `PATH`, so that Claude Code can validate its changes. |

GitHub-hosted `ubuntu-latest` runners have Node.js, bash and docker.

### Workflow permissions

| Permission      | Copilot mode | Claude mode | Why                                                                                                                                                              |
| --------------- | ------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contents`      | `read`       | `write`     | Copilot mode: `actions/checkout` only. Claude mode: Claude Code pushes its fix branches.                                                                         |
| `issues`        | `write`      | `read`      | Copilot mode: the action creates, updates and closes its issues. Claude mode: the action finds its labeled pull requests through the issues API.                 |
| `pull-requests` | `read`       | `write`     | Copilot mode: the action finds the pull requests that Copilot links to its issues. Claude mode: Claude Code opens the pull requests, and the action labels them. |

### Averlon API keys

Create the key pairs in the Averlon Console (API Keys → Create New Key). You need Averlon admin access. If you do not have it, ask an Averlon org admin.

- **GitActions** scope, for the action itself: see [API key setup](../docs/actions-api-setup.md). Store it as the secrets `AVERLON_API_KEY` and `AVERLON_API_SECRET`.
- **MCPClient** scope, for the Averlon MCP server:
  - Copilot mode: store it in the `copilot` environment of the repository, as in [MCP setup](../docs/mcp-setup.md).
  - Claude mode: store it as the secrets `AVERLON_MCP_API_KEY` and `AVERLON_MCP_API_SECRET`, and pass them as `mcp-api-key` and `mcp-api-secret`.

#### MCP keys

In Claude mode the action starts the Averlon MCP server for Claude Code. The server accepts only a key with the MCPClient scope, so `mcp-api-key` and `mcp-api-secret` are required: without them the action fails before it gets any misconfigurations. The action does not use the GitActions key pair for the MCP server.

## 🤖 Copilot Mode

### Workflow

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
      issues: write
      pull-requests: read
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: 1.5.0 # the version that your repository uses
          terraform_wrapper: false # the wrapper adds text to the output of `terraform show -json`

      - name: Generate Terraform plan
        working-directory: ./infrastructure # the directory of your Terraform code
        run: |
          terraform init
          terraform plan -out=tfplan
          terraform show -json tfplan > plan.json

      - name: Run Averlon Remediation Agent for IaC Misconfigurations
        uses: averlon-ai/actions/iac-misconfig-analysis@v2.1.0
        with:
          averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
          averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
          account-id: '123456789012' # the account that the plan deploys to, or set cloud-id
          plan-path: ./infrastructure/plan.json
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

If your Terraform code is at the root of the repository, remove `working-directory` and use `./plan.json` for `plan-path`.

To assign the issues to Copilot, set `auto-assign-copilot: 'true'` and give a PAT with Copilot access as `github-token`. The workflow `GITHUB_TOKEN` cannot assign Copilot.

For Pulumi, set `iac-type: pulumi` and give the output of `pulumi stack export` as `pulumi-stack-path`, instead of `plan-path`.

### GitHub issues

- **Batches:** each issue has up to 10 resources.
- **Label:** `averlon-iac-misconfiguration-analysis`.
- **Content:** the repository and commit, a summary, each resource with its asset details and Averlon issue IDs, reachability when known, and next steps.
- **Updates:** a later run updates an issue when its batch changes, and closes the issues of batches that no longer exist.
- **Averlon:** the action registers each issue, and the pull requests that Copilot links to it, with Averlon.

### Output only

Leave out `github-token` to get only the `scan-result` output, with no issues:

```yaml
- name: Run Averlon Remediation Agent for IaC Misconfigurations
  id: scan
  uses: averlon-ai/actions/iac-misconfig-analysis@v2.1.0
  with:
    averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
    averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
    account-id: '123456789012'
    plan-path: ./plan.json

- name: Process scan results
  env:
    SCAN_RESULT: ${{ steps.scan.outputs.scan-result }}
  run: echo "$SCAN_RESULT" | jq 'length'
```

## 🧠 Claude Mode

### Workflow

```yaml
name: Averlon IaC Remediation
on:
  workflow_dispatch: {}
  schedule:
    - cron: '0 2 * * *'

# One run at a time, so that two runs do not open pull requests for the same misconfigurations.
concurrency: averlon-iac-remediation

jobs:
  remediate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: read
      id-token: write # only for the AWS role below
    steps:
      - name: Checkout code
        uses: actions/checkout@v6

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false # the wrapper adds text to the output of `terraform show -json`

      # Credentials only for the plan step: Claude Code runs shell commands in this job.
      - name: Configure AWS credentials
        id: aws
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: ${{ secrets.AWS_PLAN_ROLE }} # a read-only role is enough for a plan
          aws-region: us-east-1
          output-credentials: true
          output-env-credentials: false

      # Keep the plan out of the checkout: it can contain secrets.
      - name: Generate Terraform plan
        env:
          AWS_ACCESS_KEY_ID: ${{ steps.aws.outputs.aws-access-key-id }}
          AWS_SECRET_ACCESS_KEY: ${{ steps.aws.outputs.aws-secret-access-key }}
          AWS_SESSION_TOKEN: ${{ steps.aws.outputs.aws-session-token }}
          AWS_REGION: us-east-1
        run: |
          terraform init
          terraform plan -out="${{ runner.temp }}/tfplan"
          terraform show -json "${{ runner.temp }}/tfplan" > "${{ runner.temp }}/plan.json"

      - name: Run Averlon Remediation Agent for IaC Misconfigurations
        uses: averlon-ai/actions/iac-misconfig-analysis@v2.1.0
        with:
          agent-mode: claude
          averlon-api-key: ${{ secrets.AVERLON_API_KEY }}
          averlon-api-secret: ${{ secrets.AVERLON_API_SECRET }}
          mcp-api-key: ${{ secrets.AVERLON_MCP_API_KEY }}
          mcp-api-secret: ${{ secrets.AVERLON_MCP_API_SECRET }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          account-id: '123456789012' # the account that the plan deploys to, or set cloud-id
          plan-path: ${{ runner.temp }}/plan.json
```

For Azure or GCP, get the credentials for the plan step in the same way, and set `account-id` to the subscription ID or the project ID.

### How Claude mode works

1. The action correlates the plan with the Averlon misconfigurations, as in Copilot mode.
2. It gets the misconfigurations of the correlated resources from Averlon. One run sends Claude Code as many as fit in one prompt. The next run gets the others.
3. It marks the misconfigurations that it sends as in progress in Averlon.
4. Claude Code fixes them with the `remediate-iac` skill:
   - It uses the plan address to find the Terraform code of each cloud resource. It changes only the code that it can map to the resource with confidence. Otherwise it changes nothing and reports NoFix with the reason.
   - It groups the fixes by type (for example public access, encryption, logging) into at most 6 pull requests, on branches named `averlon-iac-<run ID>/<group>`, based on the default branch.
   - It runs `terraform fmt`, `terraform init -backend=false` and `terraform validate` on its changes. It never runs `terraform plan`, `apply` or `state`, and never reads state files.
5. The action labels each pull request, and reports Fixed or NoFix for each misconfiguration to Averlon.

Averlon does not send a misconfiguration again while a run works on it (by default for 2 hours), or for some time after a NoFix (by default 2 days). A misconfiguration that Claude Code does not report on goes back to pending for the next run.

### Security

Claude Code can run shell commands in the job, so it can read what is in the job environment:

- Give the cloud credentials only to the plan step, as in the example, and use a read-only role.
- Write the plan to `${{ runner.temp }}`, not into the checkout. Claude Code does not need the plan.
- Do not put secrets that Claude Code does not need in the `env` of the job.

### Claude on Amazon Bedrock

Set `use-bedrock: true` and leave out `anthropic-api-key`. Claude Code needs the AWS credentials in the environment: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` for temporary credentials), or `AWS_BEARER_TOKEN_BEDROCK`, and `AWS_REGION`. An instance or pod role alone is not enough. Use a role that can only call Bedrock, because Claude Code can read these credentials.

```yaml
- name: Configure AWS credentials for Bedrock
  uses: aws-actions/configure-aws-credentials@v6
  with:
    role-to-assume: ${{ secrets.AWS_BEDROCK_ROLE }}
    aws-region: us-west-2

- name: Run Averlon Remediation Agent for IaC Misconfigurations
  uses: averlon-ai/actions/iac-misconfig-analysis@v2.1.0
  with:
    agent-mode: claude
    use-bedrock: true
    # the other inputs as in the workflow above, without anthropic-api-key
```

Without `model`, the action uses `us.anthropic.claude-opus-5-5`. If you set `model`, give a Bedrock model or inference profile ID, not an Anthropic model name. The role needs `bedrock:InvokeModelWithResponseStream` on that model (and on the inference profile, for a `us.` or `global.` ID).

## 📥 Inputs

### All modes

| Input                  | Required                                  | Default                        | Description                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `averlon-api-key`      | Yes                                       |                                | Averlon API key ID, GitActions scope                                                                                                                                                                     |
| `averlon-api-secret`   | Yes                                       |                                | Averlon API key secret, GitActions scope                                                                                                                                                                 |
| `cloud-id`             | Yes: `cloud-id` or `account-id`, not both |                                | Averlon cloud ID                                                                                                                                                                                         |
| `account-id`           | Yes: `cloud-id` or `account-id`, not both |                                | AWS account ID, Azure subscription ID or GCP project ID that the plan deploys to. The action finds its Averlon cloud.                                                                                    |
| `agent-mode`           | No                                        | `copilot`                      | `copilot` or `claude`                                                                                                                                                                                    |
| `iac-type`             | No                                        | `terraform`                    | `terraform` or `pulumi`. Claude mode supports `terraform` only.                                                                                                                                          |
| `plan-path`            | For Terraform                             |                                | Path to the Terraform plan JSON (`terraform show -json`)                                                                                                                                                 |
| `github-token`         | In Claude mode                            |                                | GitHub token. Copilot mode: the action creates the issues with it, or with `GITHUB_TOKEN` from the job `env`; without a token it creates none. Claude mode: Claude Code opens the pull requests with it. |
| `filters`              | No                                        | `Critical,High`                | Severities to include, comma-separated: `Critical`, `High`, `Medium`, `Low`                                                                                                                              |
| `resource-type-filter` | No                                        | all types                      | Resource types to include, comma-separated. Terraform: `aws_s3_bucket,aws_lambda_function`. Pulumi: `aws:s3/bucket:Bucket`.                                                                              |
| `base-url`             | No                                        | `https://wfe.prod.averlon.io/` | Averlon API URL                                                                                                                                                                                          |

### Copilot mode only

| Input                 | Required   | Default               | Description                                                                                |
| --------------------- | ---------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `pulumi-stack-path`   | For Pulumi |                       | Path to the output of `pulumi stack export`                                                |
| `auto-assign-copilot` | No         | `false`               | Assign the issues to the Copilot agent. Needs a PAT with Copilot access as `github-token`. |
| `commit`              | No         | the commit of the run | Commit SHA for the issue text                                                              |

### Claude mode only

| Input               | Required                  | Default                                                           | Description                                                                              |
| ------------------- | ------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `anthropic-api-key` | Yes, unless `use-bedrock` |                                                                   | Anthropic API key                                                                        |
| `mcp-api-key`       | Yes                       |                                                                   | Averlon API key ID, MCPClient scope, for the Averlon MCP server ([MCP keys](#mcp-keys))  |
| `mcp-api-secret`    | Yes                       |                                                                   | Averlon API key secret, MCPClient scope                                                  |
| `use-bedrock`       | No                        | `false`                                                           | Run Claude on Amazon Bedrock. See [Claude on Amazon Bedrock](#claude-on-amazon-bedrock). |
| `model`             | No                        | `claude-opus-5-5`, or `us.anthropic.claude-opus-5-5` with Bedrock | Claude model                                                                             |
| `container-engine`  | No                        | docker if present, else podman                                    | Command that runs the MCP server container: a name on `PATH` or an absolute path         |
| `disable-websearch` | No                        | `false`                                                           | Do not give Claude Code the WebSearch tool                                               |

`api-key` and `api-secret` are deprecated names of `averlon-api-key` and `averlon-api-secret`.

## 📤 Outputs

| Output        | Description                                                       |
| ------------- | ----------------------------------------------------------------- |
| `scan-result` | JSON array of the correlated resources, with their Averlon issues |

Copilot mode also writes the array to `scan-result.json` in the working directory.

```json
[
  {
    "ID": "aws_s3_bucket.logs",
    "Type": "aws_s3_bucket",
    "Name": "logs",
    "Asset": {
      "ID": "asset-123",
      "ResourceID": "arn:aws:s3:::my-logs-bucket"
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

With no correlated resources, the output is `[]`.

## 🚨 Troubleshooting

| Message                                                        | Cause and fix                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Resource not accessible by integration`                       | A workflow permission is missing. See [Workflow permissions](#workflow-permissions).                                                                   |
| `cloud-id not provided; ... issue correlation skipped`         | Set `cloud-id` or `account-id`.                                                                                                                        |
| `This workflow was triggered by '...', which is not supported` | Claude mode runs only on `workflow_dispatch`, `schedule` and `workflow_run`. Change the `on:` section.                                                 |
| `No Averlon cloud found for ...`, or an error from `GetCloud`  | The account is not onboarded to Averlon, or the GitActions key belongs to another Averlon organization.                                                |
| `Set cloud-id or account-id, not both`                         | Remove one of them.                                                                                                                                    |
| `cloud-id or account-id is required when agent-mode is claude` | Set one of them.                                                                                                                                       |
| `mcp-api-key and mcp-api-secret are required`                  | Set the MCPClient key pair. See [MCP keys](#mcp-keys).                                                                                                 |
| `API key is not authorized for MCP` (in the run log)           | The MCP key does not have the MCPClient scope. See [MCP keys](#mcp-keys).                                                                              |
| `No container engine found on the runner`                      | Install docker or podman, or give its path as `container-engine`.                                                                                      |
| `ENOENT`, or a JSON error for the plan                         | `plan-path` is wrong, or the file is not JSON. Make it with `terraform show -json`, and set `terraform_wrapper: false` in `hashicorp/setup-terraform`. |

To get debug logs, re-run the job with **Enable debug logging**, or set the repository variable `ACTIONS_STEP_DEBUG` to `true`.
