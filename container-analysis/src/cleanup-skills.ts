import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';

function main(): void {
  const skillNamesRaw = process.env.SKILL_NAMES ?? '';
  const createdClaudeDir = process.env.CREATED_CLAUDE_DIR === 'true';
  const createdSkillsDir = process.env.CREATED_SKILLS_DIR === 'true';

  const skillNames = skillNamesRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Remove each skill directory we downloaded
  for (const name of skillNames) {
    const skillDir = path.resolve('.claude/skills', name);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      core.info(`Removed skill directory: ${skillDir}`);
    }
  }

  // Remove .claude/skills if we created it and it's now empty
  if (createdSkillsDir) {
    const skillsDir = path.resolve('.claude/skills');
    try {
      fs.rmdirSync(skillsDir); // only removes if empty
      core.info('Removed .claude/skills directory');
    } catch {
      // Not empty or doesn't exist — that's fine
    }
  }

  // Remove .claude if we created it and it's now empty
  if (createdClaudeDir) {
    const claudeDir = path.resolve('.claude');
    try {
      fs.rmdirSync(claudeDir); // only removes if empty
      core.info('Removed .claude directory');
    } catch {
      // Not empty or doesn't exist — that's fine
    }
  }
}

function run(): void {
  try {
    core.info('Starting skills cleanup...');
    main();
    core.info('Skills cleanup completed');
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

export { run };

// Run the action if this file is executed directly
if (require.main === module) {
  run();
}
