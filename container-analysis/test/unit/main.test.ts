import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as core from '@actions/core';
import { run } from '../../src/main';
import {
  extractDockerfilePathFromTitle,
  normalizePathForComparison,
} from '../../src/github-issues';

describe('extractDockerfilePathFromTitle', () => {
  it('should extract simple Dockerfile path', () => {
    const title = 'Averlon Scanning: my-registry/my-app - Dockerfile';
    expect(extractDockerfilePathFromTitle(title)).toBe('Dockerfile');
  });

  it('should extract nested Dockerfile path', () => {
    const title = 'Averlon Scanning: my-registry/my-app - cmd/Dockerfile';
    expect(extractDockerfilePathFromTitle(title)).toBe('cmd/Dockerfile');
  });

  it('should handle image repository with dashes', () => {
    const title = 'Averlon Scanning: my-registry/my-app-with-dashes - Dockerfile';
    expect(extractDockerfilePathFromTitle(title)).toBe('Dockerfile');
  });

  it('should return empty string for invalid title', () => {
    const title = 'Some other issue title';
    expect(extractDockerfilePathFromTitle(title)).toBe('');
  });
});

describe('normalizePathForComparison', () => {
  it('should normalize Windows and Unix paths to be equal', () => {
    const windowsPath = 'cmd\\Dockerfile';
    const unixPath = 'cmd/Dockerfile';
    expect(normalizePathForComparison(windowsPath)).toBe(normalizePathForComparison(unixPath));
  });

  it('should convert to lowercase and normalize slashes', () => {
    const path = 'CMD\\Dockerfile';
    expect(normalizePathForComparison(path)).toBe('cmd/dockerfile');
  });

  it('should handle different paths as different', () => {
    const path1 = 'cmd/Dockerfile';
    const path2 = 'Dockerfile';
    expect(normalizePathForComparison(path1)).not.toBe(normalizePathForComparison(path2));
  });
});
