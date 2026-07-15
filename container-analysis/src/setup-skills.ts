import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as core from '@actions/core';
import { createApiClient } from '@averlon/shared';
import { DEFAULT_MCP_IMAGE, DEFAULT_MAX_TURNS } from './constants';

const SKILLS_DIR = path.resolve('.claude/skills');

// The server-built archive wraps all skills in this top-level directory,
// e.g. "remediation-agent-skills/<skillName>/<file>".
const ARCHIVE_WRAPPER_DIR = 'remediation-agent-skills';

const TAR_BLOCK_SIZE = 512;
const TAR_TYPEFLAG_DIRECTORY = '5';

interface TarEntry {
  name: string;
  typeflag: string;
  data: Buffer;
}

/**
 * Parse a standard USTAR tar buffer into its entries.
 * Each entry has a 512-byte header followed by its data, padded to the next
 * 512-byte boundary. The archive ends at a zero-filled header or end of buffer.
 */
function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= buf.length) {
    const header = buf.subarray(offset, offset + TAR_BLOCK_SIZE);

    // A zero-filled header marks the end of the archive.
    if (header.every(byte => byte === 0)) {
      break;
    }

    const nameField = header.subarray(0, 100);
    const nameEnd = nameField.indexOf(0);
    const name = nameField.subarray(0, nameEnd >= 0 ? nameEnd : 100).toString('utf8');

    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8);

    if (!name || isNaN(size) || size < 0) {
      throw new Error(`Invalid tar header at offset ${offset}: name="${name}", size="${sizeStr}"`);
    }

    const typeflag = header.subarray(156, 157).toString('utf8');

    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      throw new Error(`Tar archive is incomplete: expected ${dataEnd} bytes but got ${buf.length}`);
    }

    entries.push({ name, typeflag, data: buf.subarray(dataStart, dataEnd) });

    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    offset = dataStart + paddedSize;
  }

  return entries;
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
 * Extract a base64-encoded tar.gz skills archive into destDir.
 * Returns the sorted, deduplicated list of skill names found in the archive.
 */
function extractSkillsArchive(base64Data: string, destDir: string): string[] {
  const gzipped = Buffer.from(base64Data, 'base64');
  const tarBuf = zlib.gunzipSync(gzipped);
  const entries = parseTar(tarBuf);

  const skillNames = new Set<string>();

  for (const entry of entries) {
    if (entry.typeflag === TAR_TYPEFLAG_DIRECTORY) {
      continue;
    }

    let relName = entry.name;
    if (relName.startsWith(`${ARCHIVE_WRAPPER_DIR}/`)) {
      relName = relName.slice(ARCHIVE_WRAPPER_DIR.length + 1);
    }
    if (!relName) {
      continue;
    }

    const sepIndex = relName.indexOf('/');
    if (sepIndex <= 0) {
      // Not a "<skillName>/<file>" entry (e.g. a stray top-level file); skip it.
      continue;
    }

    const skillName = relName.slice(0, sepIndex);
    const filePath = relName.slice(sepIndex + 1);
    if (!filePath) {
      continue;
    }

    const outPath = validatePath(destDir, relName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, entry.data);
    core.info(`  Wrote ${skillName}/${filePath}`);

    skillNames.add(skillName);
  }

  return Array.from(skillNames).sort();
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

  core.info('Downloading remediation agent skills...');
  const response = await apiClient.downloadRemediationAgentSkills();

  const skillNames = response.Data ? extractSkillsArchive(response.Data, SKILLS_DIR) : [];
  if (skillNames.length === 0) {
    core.warning('No skills returned from API');
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

export { run, parseTar, extractSkillsArchive };

// Run the action if this file is executed directly
if (require.main === module) {
  run();
}
