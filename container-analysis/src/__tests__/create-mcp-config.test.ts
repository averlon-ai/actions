import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * scripts/create-mcp-config.sh picks the container engine that runs the Averlon
 * MCP server, so it is exercised here against a PATH that holds only the
 * engines a given runner would have.
 */

const SCRIPT = path.resolve(import.meta.dir, '../../scripts/create-mcp-config.sh');

const IMAGE_REF = 'ghcr.io/averlon-security/averlon-mcp:sha-test';

let tmpRoot: string;
/** PATH value per runner shape: the fake engines plus the utilities the script needs. */
const pathFor: Record<string, string> = {};
/** Absolute path to bash, resolved before the PATH is replaced. */
let bash: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-mcp-config-'));

  bash = Bun.which('bash') ?? '/bin/bash';

  // The script runs with only these directories on PATH, so a docker installed
  // on the machine running the tests cannot satisfy `command -v`.
  const toolDir = path.join(tmpRoot, 'tools');
  fs.mkdirSync(toolDir);
  for (const tool of ['mktemp', 'chmod', 'cat']) {
    const resolved = Bun.which(tool);
    if (!resolved) throw new Error(`${tool} not found on PATH`);
    fs.symlinkSync(resolved, path.join(toolDir, tool));
  }

  for (const [name, engines] of Object.entries({
    both: ['docker', 'podman'],
    'docker-only': ['docker'],
    'podman-only': ['podman'],
    none: [],
  })) {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(dir);
    for (const engine of engines) {
      fs.writeFileSync(path.join(dir, engine), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    pathFor[name] = `${dir}:${toolDir}`;
  }
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface StepResult {
  exitCode: number;
  stdout: string;
  configPath: string | null;
  configDir: string | null;
  config: Record<string, unknown> | null;
}

async function runScript(runner: string, overrides: Record<string, string> = {}) {
  const outputFile = path.join(tmpRoot, `github-output-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(outputFile, '');

  const proc = Bun.spawn([bash, SCRIPT], {
    env: {
      PATH: pathFor[runner]!,
      GITHUB_OUTPUT: outputFile,
      MCP_API_KEY: 'key-value',
      MCP_API_SECRET: 'secret-value',
      SECDI_SERVER: 'https://wfe.prod.averlon.io/',
      MCP_IMAGE_REF: IMAGE_REF,
      ...overrides,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  const outputs = fs.readFileSync(outputFile, 'utf8').split('\n');
  const outputValue = (name: string) =>
    outputs.find(line => line.startsWith(`${name}=`))?.slice(`${name}=`.length) ?? null;

  const configPath = outputValue('config-path');
  const configDir = outputValue('config-dir');
  const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;

  return { exitCode, stdout, configPath, configDir, config } satisfies StepResult;
}

function serverOf(config: Record<string, unknown> | null): { command: string; args: string[] } {
  const servers = (config as { mcpServers: Record<string, { command: string; args: string[] }> })
    .mcpServers;
  return servers['averlon-mcp']!;
}

describe('create-mcp-config.sh', () => {
  it('prefers docker when both engines are installed', async () => {
    const { exitCode, config, configDir } = await runScript('both');
    expect(exitCode).toBe(0);
    expect(serverOf(config).command).toBe('docker');
    fs.rmSync(configDir!, { recursive: true, force: true });
  });

  it('falls back to podman on a podman-only runner', async () => {
    const { exitCode, config, configDir } = await runScript('podman-only');
    expect(exitCode).toBe(0);
    expect(serverOf(config).command).toBe('podman');
    fs.rmSync(configDir!, { recursive: true, force: true });
  });

  it('fails with an actionable error when no container engine is installed', async () => {
    const { exitCode, stdout, configPath } = await runScript('none');
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('::error::No container engine found');
    expect(configPath).toBeNull();
  });

  it('passes the credentials and image to the same run arguments for either engine', async () => {
    const expected = [
      'run',
      '--rm',
      '-i',
      '-e',
      'AVERLON_API_KEY=key-value',
      '-e',
      'AVERLON_API_SECRET=secret-value',
      '-e',
      'SECDI_SERVER=https://wfe.prod.averlon.io/',
      IMAGE_REF,
    ];

    for (const runner of ['docker-only', 'podman-only']) {
      const { config, configDir } = await runScript(runner);
      expect(serverOf(config).args).toEqual(expected);
      fs.rmSync(configDir!, { recursive: true, force: true });
    }
  });

  it('keeps the config valid when a secret contains JSON metacharacters', async () => {
    const { config, configDir } = await runScript('both', {
      MCP_API_SECRET: 'a"b\\c$d`e',
    });
    expect(serverOf(config).args).toContain('AVERLON_API_SECRET=a"b\\c$d`e');
    fs.rmSync(configDir!, { recursive: true, force: true });
  });

  it('uses an engine given as a name on PATH instead of the detected one', async () => {
    const { exitCode, config, configDir } = await runScript('both', {
      CONTAINER_ENGINE: 'podman',
    });
    expect(exitCode).toBe(0);
    expect(serverOf(config).command).toBe('podman');
    fs.rmSync(configDir!, { recursive: true, force: true });
  });

  it('uses an engine given as an absolute path outside PATH', async () => {
    const outside = path.join(tmpRoot, 'outside-path');
    fs.mkdirSync(outside, { recursive: true });
    const binary = path.join(outside, 'podman');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const { exitCode, config, configDir } = await runScript('none', {
      CONTAINER_ENGINE: binary,
    });
    expect(exitCode).toBe(0);
    expect(serverOf(config).command).toBe(binary);
    fs.rmSync(configDir!, { recursive: true, force: true });
  });

  it('fails when the given path is not executable', async () => {
    const notExecutable = path.join(tmpRoot, 'not-executable-podman');
    fs.writeFileSync(notExecutable, 'nope\n', { mode: 0o644 });

    const { exitCode, stdout, configPath } = await runScript('both', {
      CONTAINER_ENGINE: notExecutable,
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('is not an executable file');
    expect(configPath).toBeNull();
  });

  it('fails when the given name is not on PATH', async () => {
    const { exitCode, stdout, configPath } = await runScript('docker-only', {
      CONTAINER_ENGINE: 'podman',
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('was not found on PATH');
    expect(configPath).toBeNull();
  });

  it('writes the config with owner-only permissions', async () => {
    const { configPath, configDir } = await runScript('both');
    expect(fs.statSync(configPath!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(configDir!).mode & 0o777).toBe(0o700);
    fs.rmSync(configDir!, { recursive: true, force: true });
  });
});
