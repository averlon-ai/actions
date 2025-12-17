# Test Suite

This directory contains the complete test suite for the Averlon Infrastructure Risk PreCog Agent action.

## Test Types

### 🔄 Integration Tests

**Location**: `integration/`

End-to-end tests that validate the complete pipeline:

- Terraform plan generation
- File uploads to Averlon API
- Security analysis results
- Real infrastructure comparison (base vs head)

**Run**: `./terraform_test.sh` (from `integration/` directory)  
**Get Started**: See `integration/QUICKSTART.md`

### 🧪 Unit Tests

**Location**: `unit/`

Fast, isolated tests for the action's core logic:

- PR comment formatting (`pr-comment.test.ts`)
- Terraform scan execution (`terraform-scan.test.ts`)
- Action input validation (`main.test.ts`)

**Run**: `bun test` (from action root)

## Quick Links

### For New Users

👉 **[integration/QUICKSTART.md](integration/QUICKSTART.md)** - Get running in 3 steps

### For Administrators

👉 **[integration/SETUP.md](integration/SETUP.md)** - Deploy base infrastructure

### For Developers

- Unit tests: Run `bun test` from action root
- Integration tests: See `integration/README.md`

## Directory Structure

```
test/
  ├── integration/           ← Integration tests
  │   ├── QUICKSTART.md      ← New user guide
  │   ├── SETUP.md           ← Admin setup guide
  │   ├── DEPLOY_BASE.sh     ← Deploy script
  │   ├── terraform_test.sh  ← Test runner
  │   ├── README.md          ← Integration test docs
  │   └── scenarios/         ← Test scenarios
  │       ├── scenario-security-group-changes/
  │       └── scenario-clean-changes/
  │
  └── unit/                  ← Unit tests
      ├── pr-comment.test.ts
      ├── terraform-scan.test.ts
      └── main.test.ts
```

## Running Tests

### Unit Tests (Fast)

```bash
# From action root
bun test

# Watch mode
bun test --watch

# Coverage
bun test --coverage
```

### Integration Tests (Full Pipeline)

```bash
# See integration/QUICKSTART.md for setup

cd integration
./terraform_test.sh                           # All scenarios
./terraform_test.sh scenario-clean-changes    # Single scenario
```

## Adding Tests

### Adding Unit Tests

Create new `.test.ts` files in `unit/` directory. Follow existing patterns.

### Adding Integration Scenarios

See `integration/SETUP.md` for detailed instructions on creating new test scenarios.

## CI/CD

Tests run automatically via GitHub Actions:

- **Unit tests**: On every PR
- **Integration tests**: Manual trigger workflow

See `.github/workflows/` for workflow configurations.
