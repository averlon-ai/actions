import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import { createApiClient, RemediationAgentSkill } from '@averlon/shared';
import { DEFAULT_MCP_IMAGE, DEFAULT_MAX_TURNS } from './constants';

const SKILLS_DIR = path.resolve('.claude/skills');

/**
 * Parse a single-file tar archive from a Buffer and return the filename and content.
 * Tar header: 512 bytes. Filename at offset 0 (100 bytes, null-terminated),
 * file size at offset 124 (12 bytes, octal null-terminated).
 * File data starts at offset 512.
 */
function extractTar(buf: Buffer): { filename: string; data: Buffer } {
  if (buf.length < 512) {
    throw new Error('Tar archive too short to contain a header');
  }

  // Read filename: first 100 bytes, null-terminated
  const filenameEnd = buf.indexOf(0, 0);
  const filename = buf
    .subarray(0, Math.min(filenameEnd >= 0 ? filenameEnd : 100, 100))
    .toString('utf8');

  if (!filename) {
    throw new Error('Tar header contains empty filename');
  }

  // Read size: 12 bytes at offset 124, octal string null/space terminated
  const sizeStr = buf.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
  const size = parseInt(sizeStr, 8);

  if (isNaN(size) || size < 0) {
    throw new Error(`Invalid tar file size: ${sizeStr}`);
  }

  if (512 + size > buf.length) {
    throw new Error(
      `Tar archive is incomplete: expected ${512 + size} bytes but got ${buf.length}`
    );
  }

  const data = buf.subarray(512, 512 + size);
  return { filename, data };
}

/**
 * Validate that a resolved path is within the destination directory (path traversal prevention).
 */
function validatePath(destDir: string, filePath: string): string {
  const resolvedDest = path.resolve(destDir);
  const resolvedPath = path.resolve(destDir, filePath);

  if (!resolvedPath.startsWith(resolvedDest + path.sep) && resolvedPath !== resolvedDest) {
    throw new Error(`Path traversal detected: ${filePath} resolves outside ${destDir}`);
  }

  return resolvedPath;
}

/**
 * Write a single skill's files to disk.
 */
function writeSkill(skill: RemediationAgentSkill): void {
  const skillDir = validatePath(SKILLS_DIR, skill.Name);

  for (const file of skill.Files) {
    // Base64-decode the tar archive
    const tarBuf = Buffer.from(file.Content, 'base64');
    const { filename, data } = extractTar(tarBuf);

    // Use the tar's embedded filename for the output path
    const outPath = validatePath(skillDir, filename);

    // Create intermediate directories
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
    core.info(`  Wrote ${skill.Name}/${filename}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.AVERLON_API_KEY;
  const apiSecret = process.env.AVERLON_API_SECRET;
  const baseUrl = process.env.AVERLON_BASE_URL;

  if (!apiKey || !apiSecret || !baseUrl) {
    throw new Error('AVERLON_API_KEY, AVERLON_API_SECRET, and AVERLON_BASE_URL must be set');
  }

  core.setSecret(apiKey);
  core.setSecret(apiSecret);

  const createdClaudeDir = !fs.existsSync('.claude');
  const createdSkillsDir = !fs.existsSync('.claude/skills');

  const apiClient = createApiClient({ apiKey, apiSecret, baseUrl });

  core.info('Fetching remediation agent skills...');
  const response = await apiClient.getRemediationAgentSkills();

  const skills = response.Skills ?? [];
  if (skills.length === 0) {
    core.warning('No skills returned from API');
  }

  const skillNames: string[] = [];

  for (const skill of skills) {
    core.info(`Installing skill: ${skill.Name}`);
    writeSkill(skill);
    skillNames.push(skill.Name);
  }

  // Fetch agent config (MCP image ref, max turns) with fallback defaults
  let mcpImageRef = DEFAULT_MCP_IMAGE;
  let agentMaxTurns = DEFAULT_MAX_TURNS;

  try {
    core.info('Fetching remediation agent config...');
    const configResponse = await apiClient.getRemediationAgentConfig();
    if (configResponse.AverlonMCPImageRef) {
      mcpImageRef = configResponse.AverlonMCPImageRef;
    }
    if (configResponse.AgentMaxTurns && configResponse.AgentMaxTurns > 0) {
      agentMaxTurns = String(configResponse.AgentMaxTurns);
    }
    core.info(`Agent config: MCP image=${mcpImageRef}, max-turns=${agentMaxTurns}`);
  } catch (err) {
    core.warning(
      `Failed to fetch agent config, using defaults: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Set outputs for cleanup step
  core.setOutput('skill-names', skillNames.join(','));
  core.setOutput('created-claude-dir', String(createdClaudeDir));
  core.setOutput('created-skills-dir', String(createdSkillsDir));
  core.setOutput('mcp-image-ref', mcpImageRef);
  core.setOutput('agent-max-turns', agentMaxTurns);

  core.info(`Installed ${skillNames.length} skills: ${skillNames.join(', ')}`);
}

async function run(): Promise<void> {
  try {
    core.info('Starting skills setup...');
    await main();
    core.info('Skills setup completed');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

export { run, extractTar, writeSkill };

// Run the action if this file is executed directly
if (require.main === module) {
  run();
}
