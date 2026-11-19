import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ACTION_DIR = path.resolve(import.meta.dir, '../..');

interface Step {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}

interface ActionYml {
  inputs: Record<string, { required?: boolean; default?: string }>;
  outputs: Record<string, { value: string }>;
  runs: { using: string; steps: Step[] };
}

const action = Bun.YAML.parse(
  fs.readFileSync(path.join(ACTION_DIR, 'action.yml'), 'utf8')
) as ActionYml;
const steps = action.runs.steps;
const correlate = steps.find(step => step.id === 'correlate')!;
const CLAUDE_MODE = "inputs.agent-mode == 'claude'";

describe('copilot mode', () => {
  it('defaults agent-mode to copilot so existing consumers are unaffected', () => {
    expect(action.inputs['agent-mode']?.default).toBe('copilot');
  });

  it('runs only the correlation step when agent-mode is copilot', () => {
    expect(correlate.if).toBeUndefined();
    const postAgent = steps.find(step => step.env?.['ANTHROPIC_KEY_CHECK_STAGE'] !== undefined);
    for (const step of steps.filter(step => step !== correlate && step !== postAgent)) {
      expect(step.if ?? '').toContain(CLAUDE_MODE);
      expect(step.if).not.toContain('||');
    }
    expect(postAgent?.if).toContain("steps.codingagent.outcome == 'failure'");
  });

  it('passes every input that main.ts reads to the correlation step', () => {
    const source = fs.readFileSync(path.join(ACTION_DIR, 'src/main.ts'), 'utf8');
    const names = [...source.matchAll(/getInputSafe\('([a-z-]+)'/g)].map(match => match[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect(action.inputs[name]).toBeDefined();
      expect(correlate.env?.[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`]).toBe(
        `\${{ inputs.${name} }}`
      );
    }
  });

  it('keeps the scan-result output', () => {
    expect(action.outputs['scan-result']?.value).toBe('${{ steps.correlate.outputs.scan-result }}');
  });
});

describe('claude mode', () => {
  it('prepares the agent before the correlation step claims code defects', () => {
    const correlateIndex = steps.indexOf(correlate);
    for (const id of ['model', 'setup-skill', 'mcp-config']) {
      expect(steps.findIndex(step => step.id === id)).toBeLessThan(correlateIndex);
    }
    const keyCheck = steps.findIndex(step => step.run?.includes('validate-anthropic-key.js'));
    expect(keyCheck).toBeLessThan(correlateIndex);
  });

  it('gives the MCP server only the MCP key pair, without a fallback to the Averlon key', () => {
    const mcpConfig = steps.find(step => step.id === 'mcp-config');
    expect(mcpConfig?.env?.['MCP_API_KEY']).toBe('${{ inputs.mcp-api-key }}');
    expect(mcpConfig?.env?.['MCP_API_SECRET']).toBe('${{ inputs.mcp-api-secret }}');
  });

  it('runs the agent only when the correlation step found code defects', () => {
    const agent = steps.find(step => step.uses?.startsWith('anthropics/claude-code-action'));
    expect(agent?.if).toContain("steps.correlate.outputs.has-findings == 'true'");
  });

  it('gives the feedback step the cloud that the correlation step found for the account', () => {
    const feedback = steps.find(step => step.run?.includes('submit-feedback.js'));
    expect(feedback?.env?.['AVERLON_CLOUD_ID']).toBe('${{ steps.correlate.outputs.cloud-id }}');
  });

  it('gives the feedback step the code defect IDs in a file, not in an environment variable', () => {
    const feedback = steps.find(step => step.run?.includes('submit-feedback.js'));
    expect(feedback?.env?.['ALL_CODE_DEFECT_IDS_FILE']).toBe(
      '${{ steps.correlate.outputs.code-defect-ids-file }}'
    );
    expect(feedback?.env?.['ALL_CODE_DEFECT_IDS']).toBeUndefined();
  });

  it('runs scripts that the build copies into dist/assets', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ACTION_DIR, 'package.json'), 'utf8')) as {
      'assets-from': string;
    };
    const scripts = steps.flatMap(step =>
      [...(step.run ?? '').matchAll(/"\$\{\{ github\.action_path \}\}\/([^"]+\.sh)"/g)].map(
        match => match[1]!
      )
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).toStartWith('dist/assets/');
      const source = path.join(pkg['assets-from'], script.slice('dist/assets/'.length));
      expect(fs.existsSync(path.resolve(ACTION_DIR, source))).toBe(true);
    }
  });
});
