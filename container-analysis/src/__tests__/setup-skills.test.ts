import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { describe, it, expect, afterEach } from 'bun:test';
import { parseTar, extractSkillsArchive } from '../setup-skills';

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
