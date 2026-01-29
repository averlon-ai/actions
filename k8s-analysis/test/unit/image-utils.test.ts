import { describe, it, expect } from 'bun:test';
import {
  normalizeImageToCanonicalRepository,
  compareTags,
  pickLatestImageInRepo,
  groupImagesByRepoAndPickLatest,
} from '../../src/image-utils';

describe('image-utils', () => {
  describe('normalizeImageToCanonicalRepository', () => {
    it('normalizes Docker Hub short names to docker.io/library/name', () => {
      expect(normalizeImageToCanonicalRepository('nginx:1.25')).toBe('docker.io/library/nginx');
      expect(
        normalizeImageToCanonicalRepository(
          'nginx@sha256:aaaaf56b44807c64d294e6c8059b479f35350b454492398225034174808d1726'
        )
      ).toBe('docker.io/library/nginx');
      expect(normalizeImageToCanonicalRepository('nginx')).toBe('docker.io/library/nginx');
    });

    it('normalizes explicit registry and path', () => {
      expect(normalizeImageToCanonicalRepository('ghcr.io/org/app:latest')).toBe('ghcr.io/org/app');
      expect(
        normalizeImageToCanonicalRepository(
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:latest'
        )
      ).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/app');
    });

    it('normalizes index.docker.io to docker.io', () => {
      expect(normalizeImageToCanonicalRepository('index.docker.io/library/ubuntu:latest')).toBe(
        'docker.io/library/ubuntu'
      );
    });

    it('normalizes Docker Hub org/repo (path with slash, no registry) to docker.io/org/repo', () => {
      expect(normalizeImageToCanonicalRepository('myorg/myimage:1.0')).toBe(
        'docker.io/myorg/myimage'
      );
    });

    it('returns null for empty or invalid input', () => {
      expect(normalizeImageToCanonicalRepository('')).toBeNull();
      expect(normalizeImageToCanonicalRepository('   ')).toBeNull();
    });
  });

  describe('compareTags', () => {
    it('compares semver tags correctly', () => {
      expect(compareTags('1.3', '1.2')).toBeGreaterThan(0);
      expect(compareTags('1.2', '1.3')).toBeLessThan(0);
      expect(compareTags('1.2', '1.2')).toBe(0);
    });

    it('treats "latest" as greatest', () => {
      expect(compareTags('latest', '1.25')).toBeGreaterThan(0);
      expect(compareTags('1.25', 'latest')).toBeLessThan(0);
    });

    it('uses string/numeric compare for non-semver tags', () => {
      expect(compareTags('alpha', 'beta')).toBeLessThan(0);
      expect(compareTags('2', '10')).toBeLessThan(0); // numeric: 2 < 10
      expect(compareTags('1.2.3-pre', '1.2.3')).toBeLessThan(0); // pre-release < release
    });
  });

  describe('pickLatestImageInRepo', () => {
    it('returns the image with latest tag when multiple exist', () => {
      expect(pickLatestImageInRepo(['nginx:1.2', 'nginx:1.3'])).toBe('nginx:1.3');
      expect(pickLatestImageInRepo(['nginx:1.19', 'nginx:1.20', 'nginx:1.18'])).toBe('nginx:1.20');
    });

    it('returns "latest" when present among versioned tags', () => {
      expect(pickLatestImageInRepo(['nginx:1.25', 'nginx:latest'])).toBe('nginx:latest');
    });

    it('returns single image when only one', () => {
      expect(pickLatestImageInRepo(['nginx:1.19'])).toBe('nginx:1.19');
    });

    it('returns null for empty array', () => {
      expect(pickLatestImageInRepo([])).toBeNull();
    });

    it('handles images with no tag (uses empty string in compare)', () => {
      // nginx (no tag) vs nginx:1.0 — no tag is compared as empty; 1.0 wins
      expect(pickLatestImageInRepo(['nginx', 'nginx:1.0'])).toBe('nginx:1.0');
      expect(pickLatestImageInRepo(['nginx:1.0', 'nginx'])).toBe('nginx:1.0');
      // Single image without tag is returned as-is
      expect(pickLatestImageInRepo(['nginx'])).toBe('nginx');
    });
  });

  describe('groupImagesByRepoAndPickLatest', () => {
    it('groups by canonical repo and picks latest per repo', () => {
      const result = groupImagesByRepoAndPickLatest([
        'nginx:1.2',
        'nginx:1.3',
        'redis:6',
        'redis:7',
      ]);
      expect(result.get('docker.io/library/nginx')).toBe('nginx:1.3');
      expect(result.get('docker.io/library/redis')).toBe('redis:7');
    });

    it('returns empty map for empty input', () => {
      const result = groupImagesByRepoAndPickLatest([]);
      expect(result.size).toBe(0);
    });

    it('skips images that normalize to null', () => {
      const result = groupImagesByRepoAndPickLatest(['', '   ', 'nginx:1.19']);
      expect(result.size).toBe(1);
      expect(result.get('docker.io/library/nginx')).toBe('nginx:1.19');
    });
  });
});
