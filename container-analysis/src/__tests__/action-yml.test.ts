import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Anthropic API key is optional once Bedrock can supply the model, so every
 * step that needs the key has to be gated on the provider.
 */

const ACTION_YML = path.resolve(import.meta.dir, '../../action.yml');

interface ActionYml {
  inputs: Record<string, { required?: boolean; default?: string }>;
  runs: {
    steps: {
      name?: string;
      id?: string;
      if?: string;
      run?: string;
      uses?: string;
      with?: Record<string, string>;
      env?: Record<string, string>;
    }[];
  };
}

const action = Bun.YAML.parse(fs.readFileSync(ACTION_YML, 'utf8')) as ActionYml;
const steps = action.runs.steps;

describe('bedrock inputs', () => {
  it('makes anthropic-api-key optional', () => {
    const input = action.inputs['anthropic-api-key'];
    expect(input).toBeDefined();
    expect(input?.required).toBe(false);
    expect(input?.default).toBe('');
  });

  it('defaults use-bedrock to false so existing consumers are unaffected', () => {
    expect(action.inputs['use-bedrock']?.default).toBe('false');
    expect(action.inputs['use-bedrock']?.required).not.toBe(true);
  });
});

describe('provider gating', () => {
  it('gates every step that reads the Anthropic API key on use-bedrock', () => {
    const keySteps = steps.filter(step => step.run?.includes('validate-anthropic-key.js') ?? false);
    expect(keySteps.length).toBeGreaterThan(0);

    for (const step of keySteps) {
      expect(step.if ?? '').toContain("inputs.use-bedrock != 'true'");
    }
  });

  it('keeps the post-agent key check conditional on the agent having failed', () => {
    const postAgent = steps.find(step => step.env?.['ANTHROPIC_KEY_CHECK_STAGE'] !== undefined);
    expect(postAgent?.if).toContain("steps.codingagent.outcome == 'failure'");
    expect(postAgent?.if).toContain('always()');
  });

  it('passes use_bedrock through to claude-code-action', () => {
    const agent = steps.find(
      step => step.uses?.startsWith('anthropics/claude-code-action') ?? false
    );
    expect(agent?.with?.['use_bedrock']).toBe('${{ inputs.use-bedrock }}');
  });

  it('prepares the agent before any step that costs money, for either provider', () => {
    const resolve = steps.findIndex(step => step.run?.includes('prepare-agent.sh') ?? false);
    const agent = steps.findIndex(
      step => step.uses?.startsWith('anthropics/claude-code-action') ?? false
    );
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeLessThan(agent);
    expect(steps[resolve]?.if).toBeUndefined();
  });

  it('passes the resolved model to the agent, not the raw input', () => {
    const agent = steps.find(
      step => step.uses?.startsWith('anthropics/claude-code-action') ?? false
    );
    expect(agent?.with?.['claude_args']).toContain('${{ steps.model.outputs.model }}');
    expect(agent?.with?.['claude_args']).not.toContain('${{ inputs.model }}');
  });
});
