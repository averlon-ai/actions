import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  toRelativePath,
  findDockerfiles,
  parseImageMap,
  buildDockerfileRequests,
  getGitRepoUrl,
  parseFilters,
} from '../../src/recommendations';

describe('recommendations.ts', () => {
  // Test data setup
  const testDir = '/tmp/test-dockerfiles';
  const testFiles = [
    {
      path: `${testDir}/Dockerfile`,
      content: `FROM node:18
LABEL maintainer="John Doe" version="1.0.0"
LABEL description="Test application"`,
    },
    {
      path: `${testDir}/cmd/Dockerfile`,
      content: `FROM node:18
LABEL maintainer="Jane Doe" version="2.0.0"`,
    },
    {
      path: `${testDir}/api/Dockerfile`,
      content: `FROM node:18
RUN npm install`,
    },
  ];

  beforeEach(async () => {
    // Create test directory and files
    await fs.promises.mkdir(`${testDir}/cmd`, { recursive: true });
    await fs.promises.mkdir(`${testDir}/api`, { recursive: true });

    for (const file of testFiles) {
      await fs.promises.writeFile(file.path, file.content);
    }
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('toRelativePath', () => {
    it('should convert absolute path to relative path', () => {
      const absolutePath = path.join(process.cwd(), 'src/file.ts');
      const result = toRelativePath(absolutePath);
      expect(result).toBe('src/file.ts');
    });

    it('should handle relative paths', () => {
      const relativePath = 'src/file.ts';
      const result = toRelativePath(relativePath);
      expect(result).toBe('src/file.ts');
    });

    it('should handle current directory path', () => {
      const currentPath = '.';
      const result = toRelativePath(currentPath);
      expect(result).toBe('.');
    });
  });

  describe('parseImageMap', () => {
    it('should parse valid multiline string', () => {
      const input = `Dockerfile=myregistry/myapp:latest
cmd/Dockerfile=myregistry/myapp-cmd:v1.0
api/Dockerfile=myregistry/myapp-api:dev`;

      const result = parseImageMap(input);

      expect(result).toEqual({
        Dockerfile: 'myregistry/myapp:latest',
        'cmd/Dockerfile': 'myregistry/myapp-cmd:v1.0',
        'api/Dockerfile': 'myregistry/myapp-api:dev',
      });
    });

    it('should handle empty string', () => {
      const result = parseImageMap('');
      expect(result).toEqual({});
    });

    it('should handle undefined input', () => {
      const result = parseImageMap(undefined);
      expect(result).toEqual({});
    });

    it('should throw on lines without equals sign', () => {
      const input = `Dockerfile=myregistry/myapp:latest
invalid-line
another/Dockerfile=myregistry/another:latest`;

      expect(() => parseImageMap(input)).toThrow('Invalid image-map format: "invalid-line"');
    });

    it('should throw on lines with empty values', () => {
      const input = `Dockerfile=myregistry/myapp:latest
empty=
valid/Dockerfile=myregistry/valid:latest`;

      expect(() => parseImageMap(input)).toThrow('Invalid image-map entry: "empty="');
    });

    it('should throw on lines using colon separator instead of equals', () => {
      const input = `Dockerfile:myregistry/myapp:latest`;

      expect(() => parseImageMap(input)).toThrow('Invalid image-map format');
    });

    it('should trim whitespace from keys and values', () => {
      const input = `  Dockerfile  =  myregistry/myapp:latest  
  cmd/Dockerfile = myregistry/myapp-cmd:v1.0  `;

      const result = parseImageMap(input);

      expect(result).toEqual({
        Dockerfile: 'myregistry/myapp:latest',
        'cmd/Dockerfile': 'myregistry/myapp-cmd:v1.0',
      });
    });
  });

  describe('parseFilters', () => {
    it('should parse single filter', () => {
      const result = parseFilters('Critical');
      expect(result).toBe(0x2); // Critical bit
    });

    it('should parse multiple filters', () => {
      const result = parseFilters('Critical,High');
      expect(result).toBe(0x6); // Critical (0x2) | High (0x4)
    });

    it('should parse all available filters', () => {
      const result = parseFilters('Recommended,Exploited,Critical,High,HighRCE,MediumApplication');
      expect(result).toBe(0x7e); // All filter bits set (0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40)
    });

    it('should handle empty string', () => {
      const result = parseFilters('');
      expect(result).toBe(0);
    });

    it('should handle undefined input', () => {
      const result = parseFilters(undefined);
      expect(result).toBe(0);
    });

    it('should ignore invalid filter names', () => {
      const result = parseFilters('Critical,InvalidFilter,High');
      expect(result).toBe(0x6); // Only Critical and High
    });

    it('should handle whitespace in filter names', () => {
      const result = parseFilters(' Critical , High ');
      expect(result).toBe(0x6);
    });

    it('should handle duplicate filter names', () => {
      const result = parseFilters('Critical,Critical,High');
      expect(result).toBe(0x6); // Duplicates don't affect bitwise OR
    });
  });

  describe('getGitRepoUrl', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return GitHub URL with default server', () => {
      process.env['GITHUB_SERVER_URL'] = undefined;
      process.env['GITHUB_REPOSITORY'] = 'owner/repo';

      const result = getGitRepoUrl();
      expect(result).toBe('https://github.com/owner/repo.git');
    });

    it('should return custom server URL', () => {
      process.env['GITHUB_SERVER_URL'] = 'https://git.company.com';
      process.env['GITHUB_REPOSITORY'] = 'owner/repo';

      const result = getGitRepoUrl();
      expect(result).toBe('https://git.company.com/owner/repo.git');
    });

    it('should return empty string when repository is not set', () => {
      process.env['GITHUB_SERVER_URL'] = 'https://github.com';
      process.env['GITHUB_REPOSITORY'] = undefined;

      const result = getGitRepoUrl();
      expect(result).toBe('');
    });

    it('should return empty string when repository is empty', () => {
      process.env['GITHUB_SERVER_URL'] = 'https://github.com';
      process.env['GITHUB_REPOSITORY'] = '';

      const result = getGitRepoUrl();
      expect(result).toBe('');
    });
  });

  describe('findDockerfiles', () => {
    it('should return sorted list of Dockerfiles', async () => {
      // Use isolated test directory to avoid searching entire repository
      const previousCwd = process.cwd();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockerfiles-test-'));
      try {
        // Create test Dockerfiles in the temp directory
        await fs.promises.mkdir(path.join(tempDir, 'subdir'), { recursive: true });
        await fs.promises.writeFile(path.join(tempDir, 'Dockerfile'), 'FROM node:18');
        await fs.promises.writeFile(path.join(tempDir, 'subdir', 'Dockerfile'), 'FROM node:18');
        await fs.promises.writeFile(path.join(tempDir, 'app.dockerfile'), 'FROM node:18');

        process.chdir(tempDir);
        const result = await findDockerfiles();

        // The result should be an array
        expect(Array.isArray(result)).toBe(true);

        // Should find the Dockerfiles we created
        expect(result.length).toBeGreaterThanOrEqual(3);

        // Results should be sorted
        const sorted = [...result].sort();
        expect(result).toEqual(sorted);

        // Verify specific files are found by checking if they resolve to our test files
        const expectedFiles = [
          path.join(tempDir, 'Dockerfile'),
          path.join(tempDir, 'subdir', 'Dockerfile'),
          path.join(tempDir, 'app.dockerfile'),
        ];
        const resolvedResults = result.map(p => {
          return path.isAbsolute(p) ? p : path.resolve(tempDir, p);
        });
        for (const expectedFile of expectedFiles) {
          expect(resolvedResults).toContain(expectedFile);
        }
      } finally {
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should return empty array when no Dockerfiles found', async () => {
      const previousCwd = process.cwd();
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-dockerfiles-'));
      try {
        process.chdir(tempDir);
        const result = await findDockerfiles();
        expect(result).toEqual([]);
      } finally {
        process.chdir(previousCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('buildDockerfileRequests', () => {
    it('should build requests with Docker labels and image mapping', () => {
      const dockerfiles = [`${testDir}/Dockerfile`, `${testDir}/cmd/Dockerfile`];

      // Get the actual relative paths that will be generated
      const relPath1 = toRelativePath(`${testDir}/Dockerfile`);
      const relPath2 = toRelativePath(`${testDir}/cmd/Dockerfile`);

      const imageMap = {
        [relPath1]: 'myregistry/myapp:latest',
        [relPath2]: 'myregistry/myapp-cmd:v1.0',
      };

      const result = buildDockerfileRequests(dockerfiles, imageMap);

      expect(result).toHaveLength(2);

      // Check first result
      expect(result[0].Path).toBe(relPath1);
      expect(result[0].Type).toBe(1);
      expect(result[0].Content).toBe('');
      expect(result[0].ImageRepository).toBe('myregistry/myapp:latest');
      expect(result[0].Metadata).toContainEqual({ Key: 'label:maintainer', Value: 'John Doe' });
      expect(result[0].Metadata).toContainEqual({ Key: 'label:version', Value: '1.0.0' });
      expect(result[0].Metadata).toContainEqual({
        Key: 'label:description',
        Value: 'Test application',
      });
      expect(result[0].Metadata).toContainEqual({
        Key: 'ImageRepository',
        Value: 'myregistry/myapp:latest',
      });

      // Check second result
      expect(result[1].Path).toBe(relPath2);
      expect(result[1].Type).toBe(1);
      expect(result[1].Content).toBe('');
      expect(result[1].ImageRepository).toBe('myregistry/myapp-cmd:v1.0');
      expect(result[1].Metadata).toContainEqual({ Key: 'label:maintainer', Value: 'Jane Doe' });
      expect(result[1].Metadata).toContainEqual({ Key: 'label:version', Value: '2.0.0' });
      expect(result[1].Metadata).toContainEqual({
        Key: 'ImageRepository',
        Value: 'myregistry/myapp-cmd:v1.0',
      });
    });

    it('should handle Dockerfiles without image mapping', () => {
      const dockerfiles = [`${testDir}/Dockerfile`];
      const imageMap = {};

      const result = buildDockerfileRequests(dockerfiles, imageMap);

      expect(result).toHaveLength(1);
      expect(result[0].Path).toContain('Dockerfile');
      expect(result[0].Type).toBe(1);
      expect(result[0].Content).toBe('');
      expect(result[0].ImageRepository).toBe('');
      expect(result[0].Metadata).toContainEqual({ Key: 'label:maintainer', Value: 'John Doe' });
      expect(result[0].Metadata).toContainEqual({ Key: 'label:version', Value: '1.0.0' });
      expect(result[0].Metadata).toContainEqual({
        Key: 'label:description',
        Value: 'Test application',
      });
    });

    it('should handle Dockerfiles without labels', () => {
      const dockerfiles = [`${testDir}/api/Dockerfile`];

      // Get the actual relative path that will be generated
      const relPath = toRelativePath(`${testDir}/api/Dockerfile`);
      const imageMap = { [relPath]: 'myregistry/myapp-api:latest' };

      const result = buildDockerfileRequests(dockerfiles, imageMap);

      expect(result).toHaveLength(1);
      expect(result[0].Path).toBe(relPath);
      expect(result[0].Type).toBe(1);
      expect(result[0].Content).toBe('');
      expect(result[0].ImageRepository).toBe('myregistry/myapp-api:latest');
      expect(result[0].Metadata).toContainEqual({
        Key: 'ImageRepository',
        Value: 'myregistry/myapp-api:latest',
      });
    });

    it('should handle empty Dockerfiles array', () => {
      const dockerfiles: string[] = [];
      const imageMap = {};

      const result = buildDockerfileRequests(dockerfiles, imageMap);

      expect(result).toEqual([]);
    });
  });

  // Tests for internal functions through public API
  describe('normalizeAndJoinContinuedLines (internal)', () => {
    it('should handle line continuations through buildDockerfileRequests', () => {
      // Create a Dockerfile with line continuations
      const dockerfileWithContinuations = `FROM node:18 \\
  AS builder \\
  WORKDIR /app \\
  COPY package*.json ./ \\
  RUN npm install`;

      // Write the file and test through buildDockerfileRequests
      const testFile = `${testDir}/continued.Dockerfile`;
      fs.writeFileSync(testFile, dockerfileWithContinuations);

      const result = buildDockerfileRequests([testFile], {});

      expect(result).toHaveLength(1);
      expect(result[0].Path).toContain('continued.Dockerfile');
    });
  });

  describe('parseDockerLabels (internal)', () => {
    it('should parse simple labels through buildDockerfileRequests', () => {
      const dockerfiles = [`${testDir}/Dockerfile`];
      const result = buildDockerfileRequests(dockerfiles, {});

      expect(result[0].Metadata).toContainEqual({ Key: 'label:maintainer', Value: 'John Doe' });
      expect(result[0].Metadata).toContainEqual({ Key: 'label:version', Value: '1.0.0' });
      expect(result[0].Metadata).toContainEqual({
        Key: 'label:description',
        Value: 'Test application',
      });
    });

    it('should handle multi-line labels through buildDockerfileRequests', () => {
      const multiLineDockerfile = `FROM node:18
LABEL maintainer="John Doe" \\
    version="1.0.0" \\
    description="My application"`;

      const testFile = `${testDir}/multiline.Dockerfile`;
      fs.writeFileSync(testFile, multiLineDockerfile);

      const result = buildDockerfileRequests([testFile], {});

      expect(result[0].Metadata).toContainEqual({ Key: 'label:maintainer', Value: 'John Doe' });
      expect(result[0].Metadata).toContainEqual({ Key: 'label:version', Value: '1.0.0' });
      expect(result[0].Metadata).toContainEqual({
        Key: 'label:description',
        Value: 'My application',
      });
    });

    it('should handle quoted values through buildDockerfileRequests', () => {
      const quotedDockerfile = `FROM node:18
LABEL description="My application with spaces"
LABEL maintainer="John Doe"`;

      const testFile = `${testDir}/quoted.Dockerfile`;
      fs.writeFileSync(testFile, quotedDockerfile);

      const result = buildDockerfileRequests([testFile], {});

      expect(result[0].Metadata).toContainEqual({
        Key: 'label:description',
        Value: 'My application with spaces',
      });
      expect(result[0].Metadata).toContainEqual({ Key: 'label:maintainer', Value: 'John Doe' });
    });

    it('should handle unquoted values through buildDockerfileRequests', () => {
      const unquotedDockerfile = `FROM node:18
LABEL version=1.0.0
LABEL maintainer=JohnDoe`;

      const testFile = `${testDir}/unquoted.Dockerfile`;
      fs.writeFileSync(testFile, unquotedDockerfile);

      const result = buildDockerfileRequests([testFile], {});

      expect(result[0].Metadata).toContainEqual({ Key: 'label:version', Value: '1.0.0' });
      expect(result[0].Metadata).toContainEqual({ Key: 'label:maintainer', Value: 'JohnDoe' });
    });

    it('should handle complex label syntax through buildDockerfileRequests', () => {
      const complexDockerfile = `FROM node:18
LABEL com.example.vendor="ACME Incorporated"
LABEL com.example.label-with-value="foo"
LABEL version="1.0"`;

      const testFile = `${testDir}/complex.Dockerfile`;
      fs.writeFileSync(testFile, complexDockerfile);

      const result = buildDockerfileRequests([testFile], {});

      expect(result[0].Metadata).toContainEqual({
        Key: 'label:com.example.vendor',
        Value: 'ACME Incorporated',
      });
      expect(result[0].Metadata).toContainEqual({
        Key: 'label:com.example.label-with-value',
        Value: 'foo',
      });
      expect(result[0].Metadata).toContainEqual({ Key: 'label:version', Value: '1.0' });
    });
  });
});
