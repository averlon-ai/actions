# Create Averlon API Keys and Save as GitHub Secrets

Follow these steps to generate the required Averlon API keys and store them securely as GitHub Secrets.

## Create a GitActions-scoped API key pair (required)

Use this key pair for the GitHub Action to authenticate with Averlon

1. **Create a GitActions-scoped key pair in Averlon**
   - Sign in to the Averlon Console
   - Navigate to API Keys → Create New Key
   - Select scope: `GitActions`
   - Create the key pair and copy both values: `Key ID` and `Key Secret`

2. **Store these in your repository or organization secrets**
   - Go to GitHub → Settings → Secrets and variables → Actions
   - Add new repository (or organization) secrets:
     - `AVERLON_API_KEY` → paste `Key ID`
     - `AVERLON_API_SECRET` → paste `Key Secret`

Your workflow should reference these secrets:

```yaml
with:
  api-key: ${{ secrets.AVERLON_API_KEY }}
  api-secret: ${{ secrets.AVERLON_API_SECRET }}
```
