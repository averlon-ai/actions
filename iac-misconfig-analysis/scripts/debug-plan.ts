#!/usr/bin/env -S npx tsx
/**
 * Debug script: preview parsed Terraform plan/state or Pulumi stack export resources.
 * Use before running the action to verify resource extraction and cloud ID candidates.
 *
 * Usage:
 *   npx tsx scripts/debug-plan.ts <path-to-plan-or-stack.json> [terraform|pulumi]
 *   INPUT_PLAN_PATH=plan.json npx tsx scripts/debug-plan.ts
 *
 * Accepts Terraform plan JSON (`resource_changes`), `terraform show -json` state output,
 * or raw `.tfstate` files.
 *
 * Does not depend on @actions/core or API credentials.
 */
import { readFileSync } from 'node:fs';
import { parseTerraformJson } from '../src/terraform-local';
import { parsePulumiStackJson } from '../src/pulumi';

function detectIacType(path: string, explicit?: string): 'terraform' | 'pulumi' {
  if (explicit === 'terraform' || explicit === 'pulumi') return explicit;
  if (path.toLowerCase().includes('pulumi')) return 'pulumi';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (parsed['deployment'] && typeof parsed['deployment'] === 'object') {
      return 'pulumi';
    }
  } catch {
    // fall through to terraform default
  }
  return 'terraform';
}

function detectTerraformInputKind(content: string): 'plan' | 'state' {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (Array.isArray(parsed['resource_changes'])) return 'plan';
    return 'state';
  } catch {
    return 'plan';
  }
}

const inputPath =
  process.argv[2] || process.env['INPUT_PULUMI_STACK_PATH'] || process.env['INPUT_PLAN_PATH'];

if (!inputPath) {
  console.error(
    'Usage: npx tsx scripts/debug-plan.ts <path-to-plan-or-stack.json> [terraform|pulumi]'
  );
  console.error('   or set INPUT_PLAN_PATH / INPUT_PULUMI_STACK_PATH');
  process.exit(1);
}

let content: string;
try {
  content = readFileSync(inputPath, 'utf-8');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to read ${inputPath}: ${message}`);
  process.exit(1);
}

const iacType = detectIacType(inputPath, process.argv[3] || process.env['INPUT_IAC_TYPE']);
const sizeKb = (Buffer.byteLength(content, 'utf-8') / 1024).toFixed(1);

console.log('═══ IaC plan preview ═══');
console.log(`  File     : ${inputPath}`);
console.log(`  Size     : ${sizeKb} KB`);
console.log(`  IaC type : ${iacType}`);
if (iacType === 'terraform') {
  console.log(`  TF input : ${detectTerraformInputKind(content)}`);
}
console.log('');

if (iacType === 'pulumi') {
  const resources = parsePulumiStackJson(content);
  const typeCounts = new Map<string, number>();
  for (const resource of resources) {
    typeCounts.set(resource.type, (typeCounts.get(resource.type) ?? 0) + 1);
  }

  console.log(`Parsed ${resources.length} Pulumi resource(s) with stable cloud ID candidates`);
  console.log('');
  console.log('Resource types:');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }
  console.log('');
  const gcpResources = resources.filter(
    resource => resource.type.startsWith('gcp:') || resource.type.startsWith('google_')
  );
  if (gcpResources.length > 0) {
    console.log('');
    console.log(`GCP/Pulumi resources (${gcpResources.length}) with candidate IDs:`);
    for (const resource of gcpResources) {
      console.log(`  - ${resource.type} (${resource.operation}) ${resource.name}`);
      for (const id of resource.candidateResourceIds) {
        console.log(`      ${id}`);
      }
    }
  }

  console.log('');
  console.log('Sample resources (first 15):');
  for (const resource of resources.slice(0, 15)) {
    console.log(`  - ${resource.type} (${resource.operation}) ${resource.name}`);
  }
  if (resources.length > 15) {
    console.log(`  ... and ${resources.length - 15} more`);
  }
} else {
  const resources = parseTerraformJson(content);
  const typeCounts = new Map<string, number>();
  const operationCounts = new Map<string, number>();
  for (const resource of resources) {
    typeCounts.set(resource.type, (typeCounts.get(resource.type) ?? 0) + 1);
    operationCounts.set(resource.operation, (operationCounts.get(resource.operation) ?? 0) + 1);
  }

  console.log(`Parsed ${resources.length} Terraform resource(s) with stable cloud ID candidates`);
  console.log('');
  console.log('Operations:');
  for (const [operation, count] of [...operationCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${operation}: ${count}`);
  }
  console.log('');
  console.log('Resource types:');
  for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  const gcpResources = resources.filter(resource => resource.type.startsWith('google_'));
  if (gcpResources.length > 0) {
    console.log('');
    console.log(`GCP resources (${gcpResources.length}) with CAI candidates:`);
    for (const resource of gcpResources.slice(0, 25)) {
      const caiIds = resource.candidateResourceIds.filter(id => id.startsWith('//'));
      console.log(`  - ${resource.type} (${resource.operation}) ${resource.name}`);
      if (caiIds.length > 0) {
        for (const id of caiIds.slice(0, 3)) {
          console.log(`      ${id}`);
        }
        if (caiIds.length > 3) {
          console.log(`      ... +${caiIds.length - 3} more CAI candidate(s)`);
        }
      } else {
        const fallback = resource.candidateResourceIds.slice(0, 2).join(', ');
        if (fallback) console.log(`      (no CAI) ${fallback}`);
      }
    }
    if (gcpResources.length > 25) {
      console.log(`  ... and ${gcpResources.length - 25} more GCP resource(s)`);
    }
  }

  console.log('');
  console.log('Sample resources (first 15):');
  for (const resource of resources.slice(0, 15)) {
    const ids = resource.candidateResourceIds
      .filter(
        id => id.startsWith('//') || id.startsWith('arn:') || id.startsWith('/subscriptions/')
      )
      .slice(0, 2)
      .join(', ');
    console.log(`  - ${resource.type} (${resource.operation}) ${resource.name}`);
    if (ids) console.log(`      IDs: ${ids}`);
  }
  if (resources.length > 15) {
    console.log(`  ... and ${resources.length - 15} more`);
  }
}
