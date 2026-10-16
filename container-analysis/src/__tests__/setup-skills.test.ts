import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, it, expect, afterEach } from 'bun:test';
import { parseTar, extractSkillsArchive, excludeSkillsFromGit } from '../setup-skills';

const TAR_BLOCK_SIZE = 512;

function tarHeader(name: string, size: number, typeflag = '0'): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(name, 0, 'utf8');
  // Fill mode/uid/gid with non-zero octal digits, like a real tar writer would,
  // so a 100-byte name with no NUL terminator can't be masked by adjacent zeroed fields.
  header.write('0000644\0', 100, 'utf8');
  header.write('0000000\0', 108, 'utf8');
  header.write('0000000\0', 116, 'utf8');
  header.write(size.toString(8).padStart(11, '0'), 124, 'utf8');
  header.write(typeflag, 156, 'utf8');
  return header;
}

function tarEntry(name: string, content: string, typeflag = '0'): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = tarHeader(name, data.length, typeflag);
  const paddedSize = Math.ceil(data.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const padded = Buffer.alloc(paddedSize);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function buildTar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(TAR_BLOCK_SIZE * 2)]);
}

describe('parseTar', () => {
  it('parses multiple entries and skips directory entries', () => {
    const tar = buildTar([
      tarEntry('remediation-agent-skills/', '', '5'),
      tarEntry('remediation-agent-skills/fix-go-vulns/', '', '5'),
      tarEntry('remediation-agent-skills/fix-go-vulns/SKILL.md', 'go skill content'),
      tarEntry('remediation-agent-skills/fix-js-vulns/SKILL.md', 'js skill content'),
    ]);

    const entries = parseTar(tar);
    const files = entries.filter(e => e.typeflag !== '5');

    expect(files).toHaveLength(2);
    expect(files[0]?.name).toBe('remediation-agent-skills/fix-go-vulns/SKILL.md');
    expect(files[0]?.data.toString('utf8')).toBe('go skill content');
    expect(files[1]?.name).toBe('remediation-agent-skills/fix-js-vulns/SKILL.md');
  });

  it('throws on an incomplete archive', () => {
    const header = tarHeader('truncated.txt', 100);
    expect(() => parseTar(header)).toThrow('incomplete');
  });

  it('parses a name that fills the entire 100-byte name field with no NUL terminator', () => {
    const prefix = 'remediation-agent-skills/fix-go-vulns/';
    const name = prefix + 'x'.repeat(100 - prefix.length);
    expect(name).toHaveLength(100);

    const tar = buildTar([tarEntry(name, 'content')]);
    const entries = parseTar(tar);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe(name);
    expect(entries[0]?.data.toString('utf8')).toBe('content');
  });
});

describe('extractSkillsArchive', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function extract(entries: Buffer[]): { skillNames: string[]; destDir: string } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-skills-test-'));
    const tarBuf = buildTar(entries);
    const gz = zlib.gzipSync(tarBuf);
    const skillNames = extractSkillsArchive(gz.toString('base64'), tmpDir);
    return { skillNames, destDir: tmpDir };
  }

  it('extracts multiple skills with nested files and strips the wrapper directory', () => {
    const { skillNames, destDir } = extract([
      tarEntry('remediation-agent-skills/fix-go-vulns/SKILL.md', 'go skill content'),
      tarEntry('remediation-agent-skills/fix-go-vulns/EXAMPLES.md', 'go examples'),
      tarEntry('remediation-agent-skills/fix-js-vulns/SKILL.md', 'js skill content'),
    ]);

    expect(skillNames).toEqual(['fix-go-vulns', 'fix-js-vulns']);
    expect(fs.readFileSync(path.join(destDir, 'fix-go-vulns/SKILL.md'), 'utf8')).toBe(
      'go skill content'
    );
    expect(fs.readFileSync(path.join(destDir, 'fix-go-vulns/EXAMPLES.md'), 'utf8')).toBe(
      'go examples'
    );
    expect(fs.readFileSync(path.join(destDir, 'fix-js-vulns/SKILL.md'), 'utf8')).toBe(
      'js skill content'
    );
  });

  it('deduplicates skill names across multiple files', () => {
    const { skillNames } = extract([
      tarEntry('remediation-agent-skills/fix-go-vulns/SKILL.md', 'a'),
      tarEntry('remediation-agent-skills/fix-go-vulns/EXAMPLES.md', 'b'),
    ]);

    expect(skillNames).toEqual(['fix-go-vulns']);
  });

  it('skips directory entries', () => {
    const { skillNames, destDir } = extract([
      tarEntry('remediation-agent-skills/', '', '5'),
      tarEntry('remediation-agent-skills/fix-go-vulns/', '', '5'),
      tarEntry('remediation-agent-skills/fix-go-vulns/SKILL.md', 'go skill content'),
    ]);

    expect(skillNames).toEqual(['fix-go-vulns']);
    expect(fs.existsSync(path.join(destDir, 'fix-go-vulns/SKILL.md'))).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-skills-test-'));
    const tarBuf = buildTar([
      tarEntry('remediation-agent-skills/../../evil/SKILL.md', 'malicious content'),
    ]);
    const gz = zlib.gzipSync(tarBuf);

    expect(() => extractSkillsArchive(gz.toString('base64'), tmpDir)).toThrow(
      'Path traversal detected'
    );
  });
});

describe('excludeSkillsFromGit', () => {
  let repo: string;

  afterEach(() => {
    if (repo) {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  }

  function installSkills(names: string[]): string {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-skills-git-'));
    git('init', '-q');
    const skillsDir = path.join(repo, '.claude/skills');
    for (const name of names) {
      fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, name, 'SKILL.md'), name);
    }
    return skillsDir;
  }

  const excludeFile = () => fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8');

  it('keeps the installed skills out of git add -A', () => {
    const skillsDir = installSkills(['fix-go-vulns', 'remediate-container']);
    fs.writeFileSync(path.join(repo, 'Dockerfile'), 'FROM scratch\n');

    excludeSkillsFromGit(skillsDir, ['fix-go-vulns', 'remediate-container']);
    git('add', '-A');

    expect(excludeFile()).toContain('/.claude/skills/fix-go-vulns/\n');
    expect(excludeFile()).toContain('/.claude/skills/remediate-container/\n');
    expect(git('diff', '--cached', '--name-only').trim()).toBe('Dockerfile');
  });

  it('does not exclude skills of the repository that are not installed by the action', () => {
    const skillsDir = installSkills(['fix-go-vulns', 'team-skill']);

    excludeSkillsFromGit(skillsDir, ['fix-go-vulns']);
    git('add', '-A');

    expect(git('diff', '--cached', '--name-only').trim()).toBe(
      '.claude/skills/team-skill/SKILL.md'
    );
  });

  it('adds each line once when it runs again', () => {
    const skillsDir = installSkills(['fix-go-vulns']);

    excludeSkillsFromGit(skillsDir, ['fix-go-vulns']);
    excludeSkillsFromGit(skillsDir, ['fix-go-vulns']);

    const matches = excludeFile()
      .split('\n')
      .filter(line => line === '/.claude/skills/fix-go-vulns/');
    expect(matches).toHaveLength(1);
  });

  it('keeps the existing exclude rules, also without a final newline', () => {
    const skillsDir = installSkills(['fix-go-vulns']);
    fs.writeFileSync(path.join(repo, '.git/info/exclude'), '*.local');

    excludeSkillsFromGit(skillsDir, ['fix-go-vulns']);

    expect(excludeFile()).toBe('*.local\n/.claude/skills/fix-go-vulns/\n');
  });

  it('does not fail outside a git repository', () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-skills-nogit-'));
    const skillsDir = path.join(repo, '.claude/skills');
    fs.mkdirSync(path.join(skillsDir, 'fix-go-vulns'), { recursive: true });

    expect(() => excludeSkillsFromGit(skillsDir, ['fix-go-vulns'])).not.toThrow();
    expect(fs.existsSync(path.join(repo, '.git'))).toBe(false);
  });
});
