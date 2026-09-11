import { describe, it, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(import.meta.dir, '../../scripts/prepare-agent.sh');
const bash = Bun.which('bash') ?? '/bin/bash';

// Each run gets its own step output file; the real one is append-only.
const BEDROCK_CREDS = {
  AWS_REGION: 'us-west-2',
  AWS_ACCESS_KEY_ID: 'AKIATEST',
  AWS_SECRET_ACCESS_KEY: 'secret',
};

async function runScript(env: Record<string, string>) {
  const outputFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-agent-')), 'output');
  fs.writeFileSync(outputFile, '');

  const proc = Bun.spawn([bash, SCRIPT], {
    env: { PATH: process.env['PATH'] ?? '', GITHUB_OUTPUT: outputFile, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  const model =
    fs
      .readFileSync(outputFile, 'utf8')
      .split('\n')
      .find(line => line.startsWith('model='))
      ?.slice('model='.length) ?? null;
  return { exitCode, stdout, model };
}

describe('prepare-agent.sh', () => {
  it('defaults to an Anthropic model id', async () => {
    const { exitCode, model } = await runScript({ MODEL: '', USE_BEDROCK: 'false' });
    expect(exitCode).toBe(0);
    expect(model).toBe('claude-opus-5');
  });

  it('defaults to a Bedrock model id under use-bedrock', async () => {
    const { exitCode, model } = await runScript({
      MODEL: '',
      USE_BEDROCK: 'true',
      ...BEDROCK_CREDS,
    });
    expect(exitCode).toBe(0);
    expect(model).toBe('us.anthropic.claude-opus-5');
  });

  it('keeps an explicit model on either provider', async () => {
    expect((await runScript({ MODEL: 'claude-sonnet-5', USE_BEDROCK: 'false' })).model).toBe(
      'claude-sonnet-5'
    );
    expect(
      (
        await runScript({
          MODEL: 'global.anthropic.claude-sonnet-4-6',
          USE_BEDROCK: 'true',
          ...BEDROCK_CREDS,
        })
      ).model
    ).toBe('global.anthropic.claude-sonnet-4-6');
  });

  it.each([
    'anthropic.claude-opus-4-6-v1',
    'us.anthropic.claude-opus-4-5-20251101-v1:0',
    'global.anthropic.claude-opus-5',
  ])('accepts the Bedrock model id %s', async model => {
    expect(
      (await runScript({ MODEL: model, USE_BEDROCK: 'true', ...BEDROCK_CREDS })).exitCode
    ).toBe(0);
  });

  it('fails when no AWS credentials are in the environment', async () => {
    const { exitCode, stdout, model } = await runScript({
      MODEL: '',
      USE_BEDROCK: 'true',
      AWS_REGION: 'us-west-2',
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('No AWS credentials in the environment');
    expect(model).toBeNull();
  });

  it('accepts a Bedrock bearer token instead of access keys', async () => {
    const { exitCode, model } = await runScript({
      MODEL: '',
      USE_BEDROCK: 'true',
      AWS_REGION: 'us-west-2',
      AWS_BEARER_TOKEN_BEDROCK: 'token',
    });
    expect(exitCode).toBe(0);
    expect(model).toBe('us.anthropic.claude-opus-5');
  });

  it('fails when AWS_REGION is missing', async () => {
    const { exitCode, stdout } = await runScript({
      MODEL: '',
      USE_BEDROCK: 'true',
      AWS_ACCESS_KEY_ID: 'AKIATEST',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('AWS_REGION is not set');
  });

  it('does not require AWS credentials on the Anthropic path', async () => {
    const { exitCode, model } = await runScript({ MODEL: '', USE_BEDROCK: 'false' });
    expect(exitCode).toBe(0);
    expect(model).toBe('claude-opus-5');
  });

  it('rejects an Anthropic model id under use-bedrock', async () => {
    const { exitCode, stdout, model } = await runScript({
      MODEL: 'claude-opus-5',
      USE_BEDROCK: 'true',
      ...BEDROCK_CREDS,
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('is not a Bedrock model id');
    expect(model).toBeNull();
  });
});
