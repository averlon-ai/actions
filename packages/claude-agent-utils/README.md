# @averlon/claude-agent-utils

Shared steps for Averlon GitHub Actions that run the Claude Code remediation agent.

## Contents

- `setup-skills`, `cleanup-skills`, `validate-anthropic-key`: action steps, each
  exported from its own entry point.
- `runSubmitFeedback(registration)`: the Submit Agent Feedback step. It saves the
  agent's feedback per code defect, then labels the agent's PRs and registers
  them as Git issues, as given by the action's `AgentPrRegistration`.
- `assets/prepare-agent.sh`, `assets/create-mcp-config.sh`: the Prepare Coding
  Agent and Create MCP Config steps.
- `constants`: defaults shared by these actions (base URL, MCP image, max turns,
  base tool allowlist, structured output schema), also exported from their own
  entry point so a step that needs only them does not bundle the rest.

## Usage

Each action keeps a small entry file per step in its `src` (`build-action.sh`
bundles only those). It sets `"assets-from": "../packages/claude-agent-utils/assets"`
in its `package.json`, so the build copies the scripts to `dist/assets`, and
calls them with `${{ github.action_path }}/dist/assets/<script>.sh`. See
`container-analysis`.
