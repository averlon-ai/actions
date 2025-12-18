# Set Up Averlon MCP Server for Copilot

Configure the Averlon MCP server in Copilot coding agent

## 1. Create an MCPClient-scoped API key pair

Use this key pair for the Github Copilot MCP Client.

1. **Create an MCPClient-scoped key pair in Averlon**
   - Sign in to the Averlon Console
   - Navigate to API Keys → Create New Key
   - Select scope: `MCPClient`
   - Create the key pair and copy both values: `Key ID` and `Key Secret`

2. **Store these in the Copilot environment secrets**
   - Go to GitHub → Settings → Environments → New environment
   - Name it `copilot` (this name is required by Copilot coding agent)
   - Add environment secrets (must start with `COPILOT_MCP_`):
     - `COPILOT_MCP_AVERLON_API_KEY` → paste `Key ID`
     - `COPILOT_MCP_AVERLON_API_SECRET` → paste `Key Secret`

> [!NOTE]
> Keep the GitActions and MCPClient key pairs separate for least-privilege isolation.
> Rotate keys periodically and remove unused keys in the Averlon Console.

## 2. Configure MCP Server in GitHub

- GitHub → Settings → Copilot → Coding agent → MCP configuration
- Add the following configuration:

```json
{
  "mcpServers": {
    "averlon-mcp": {
      "type": "local",
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "AVERLON_API_KEY=$AVERLON_API_KEY",
        "-e",
        "AVERLON_API_SECRET=$AVERLON_API_SECRET",
        "-e",
        "SECDI_SERVER=https://wfe.prod.averlon.io",
        "ghcr.io/averlon-security/averlon-mcp:sha-a8e5b91"
      ],
      "env": {
        "AVERLON_API_KEY": "COPILOT_MCP_AVERLON_API_KEY",
        "AVERLON_API_SECRET": "COPILOT_MCP_AVERLON_API_SECRET"
      },
      "tools": ["*"]
    }
  }
}
```

Reference: [Configure MCP for Copilot coding agent in the GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp).

> [!NOTE]
>
> - The MCP setup augments Copilot’s capabilities; it does not replace the need for the PAT in workflows.
