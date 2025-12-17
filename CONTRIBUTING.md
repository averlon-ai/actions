# Contributing to Averlon Actions

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## 🏗️ Project Structure

This is a **monorepo** containing multiple GitHub Actions and shared packages:

```
actions/
├── container-analysis/           # Container vulnerability remediation agent
├── iac-misconfig-analysis/   # Terraform plan misconfiguration remediation agent
├── k8s-analysis/             # Kubernetes misconfiguration remediation agent
├── iac-risk-analysis/        # Terraform infrastructure risk PreCog agent
├── packages/
│   ├── averlon-shared/      # Shared utilities and API client
│   └── docs/                # Package development documentation
└── scripts/                 # Build and development automation
```

### Architecture

- **Actions**: Each GitHub Action is a separate package with its own `package.json`
- **Packages**: Shared utilities in `packages/` directory that actions depend on
- **Workspaces**: Uses Bun workspaces for dependency management
- **Scripts**: Automation scripts for creating actions, building, and testing

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- Node.js 20+ (for GitHub Actions compatibility)
- Git

### Getting Started

1. Fork the repository
2. Clone your fork:

   ```bash
   git clone https://github.com/averlon-ai/actions.git
   cd actions
   ```

3. Install dependencies:

   ```bash
   bun install
   ```

### Quick Commands

```bash
# Create new action (uses scaffolding)
bun run create-action my-action

# Create new package (uses scaffolding)
bun run create-package my-package

# Build all actions
bun run build

# Build specific action
bun run build:iac-risk-analysis
bun run build:container-analysis
bun run build:iac-misconfig-analysis
bun run build:k8s-analysis

# Run all tests
bun test

# Run tests for specific action
cd iac-risk-analysis && bun test
cd container-analysis && bun test
cd iac-misconfig-analysis && bun test
cd k8s-analysis && bun test

# Linting and formatting
bun run lint           # Check linting
bun run lint:fix       # Fix linting issues
bun run format         # Format code
```

## Pull Request Process

1. **Create a feature branch** from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following these guidelines:
   - Write tests for new functionality
   - Update documentation as needed
   - Follow existing code patterns
   - Keep commits focused and atomic
   - **Update CHANGELOG.md** (see below)

3. **Update the Changelog**:

   For every PR that adds features, fixes bugs, or makes significant changes, add an entry to the `[Unreleased]` section of `CHANGELOG.md`:

   ```diff
   ## [Unreleased]

   ### Added
   +- New filter option for code analysis (#142)

   ### Fixed
   +- Memory leak in graph analysis (#143)
   ```

   **Categories:**
   - `### Added` - New features
   - `### Changed` - Changes in existing functionality
   - `### Deprecated` - Soon-to-be removed features
   - `### Removed` - Removed features
   - `### Fixed` - Bug fixes
   - `### Security` - Security vulnerability fixes

   **Note:** Don't change the version number or date. That only happens in release PRs.

4. **Test your changes**:

   ```bash
   bun run lint
   bun run test
   bun run build
   ```

5. **Commit your changes** with clear, descriptive messages:

   ```bash
   git commit -m "feat: add terraform graph analysis"
   ```

6. **Push to your fork**:

   ```bash
   git push origin feature/your-feature-name
   ```

7. **Create a Pull Request** with:
   - Clear title and description
   - Reference any related issues
   - Include test results
   - CHANGELOG.md updated

### Commit Message Convention

We follow conventional commits format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `test:` - Test additions/changes
- `refactor:` - Code refactoring
- `chore:` - Maintenance tasks

Examples:

```bash
git commit -m "feat: add support for custom filters"
git commit -m "fix: resolve memory leak in graph parser"
git commit -m "docs: update installation instructions"
```

## Code Guidelines

### TypeScript

- Use TypeScript for all source code
- Follow strict type checking
- Export types for public APIs
- Document complex functions with JSDoc

### Error Handling

- Use proper error types
- Provide helpful error messages
- Handle edge cases gracefully
- Log important events using `core.info()`

### Testing

- Write unit tests for new functionality
- Test error scenarios and edge cases
- Use `@types/bun` for Bun test framework
- Run tests before submitting PR

### Security

- Never commit secrets or API keys
- Use GitHub Secrets in examples
- Validate all user inputs
- Follow security best practices
- Security scans run automatically on PRs (Semgrep, TruffleHog)

## Types of Contributions

### Bug Reports

When reporting bugs, include:

- Clear reproduction steps
- Expected vs actual behavior
- Relevant logs and error messages
- Environment details (OS, Node/Bun version)
