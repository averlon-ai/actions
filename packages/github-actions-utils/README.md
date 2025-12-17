# GitHub Actions Utils

A shared package containing common utilities for GitHub Actions in the Averlon Actions monorepo.

## 📦 What's Included

### Input Utilities

- `getInputSafe(name, required?)` - Safely get input from GitHub Actions or environment variables with fallback support
- `parseBoolean(input)` - Parse boolean values from string inputs with multiple format support

## 🚀 Usage

```typescript
import { getInputSafe, parseBoolean } from '@averlon/github-actions-utils';

// Get required input with automatic fallback to environment variables
const apiKey = getInputSafe('api-key', true);

// Get optional input with default
const baseUrl = getInputSafe('base-url', false) || 'https://default.example.com';

// Parse boolean inputs
const enableFeature = parseBoolean(getInputSafe('enable-feature', false));
```

## 🔧 Features

### Safe Input Collection

The `getInputSafe` function provides robust input collection with:

- **GitHub Actions Core**: Primary source when running in GitHub Actions
- **Environment Variables**: Automatic fallback for local testing
- **Validation**: Required input validation with clear error messages
- **Debug Logging**: Detailed logging for troubleshooting

### Boolean Parsing

The `parseBoolean` function supports multiple boolean formats:

- `true`, `TRUE`, `True` → `true`
- `t`, `T` → `true`
- `1` → `true`
- `yes`, `YES` → `true`
- All other values → `false`

## 🧪 Testing

```bash
# Run tests
bun test

# Run with coverage
bun test --coverage
```

## 📚 Used By

- [Terraform Risk Analysis Action](../../iac-risk-analysis/README.md)
- [Code Analysis Action](../../container-analysis/README.md)
