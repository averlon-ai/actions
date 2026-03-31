import { describe, it, expect } from 'bun:test';
import { collectCodeDefects, buildDockerfilePrompt } from '../main';
import {
  emptyDockerfile,
  singleLayerDockerfile,
  multiLayerDockerfile,
  noCodeDefectsDockerfile,
  dockerfileWithFullCodeDefects,
} from './fixtures';

describe('collectCodeDefects', () => {
  it('returns empty array for dockerfile with no layers', () => {
    expect(collectCodeDefects(emptyDockerfile)).toEqual([]);
  });

  it('returns empty array when packages have no code defects', () => {
    expect(collectCodeDefects(noCodeDefectsDockerfile)).toEqual([]);
  });

  it('collects code defects from a single layer', () => {
    const result = collectCodeDefects(singleLayerDockerfile);
    expect(result).toHaveLength(2);
    expect(result.map(cd => cd.ID)).toEqual(['cd-001', 'cd-002']);
  });

  it('collects code defects from multiple layers and packages', () => {
    const result = collectCodeDefects(multiLayerDockerfile);
    expect(result).toHaveLength(4);
    expect(result.map(cd => cd.ID)).toEqual(['cd-101', 'cd-102', 'cd-201', 'cd-202']);
  });
});

describe('buildDockerfilePrompt', () => {
  it('includes the dockerfile path in the prompt', () => {
    const prompt = buildDockerfilePrompt(singleLayerDockerfile);
    expect(prompt).toContain(singleLayerDockerfile.Path);
  });

  it('reports the correct defect count', () => {
    const prompt = buildDockerfilePrompt(singleLayerDockerfile);
    expect(prompt).toContain('2 CodeDefect IDs');
  });

  it('includes all CodeDefect IDs in the embedded JSON', () => {
    const prompt = buildDockerfilePrompt(multiLayerDockerfile);
    expect(prompt).toContain('cd-101');
    expect(prompt).toContain('cd-102');
    expect(prompt).toContain('cd-201');
    expect(prompt).toContain('cd-202');
  });

  it('includes a JSON code block', () => {
    const prompt = buildDockerfilePrompt(singleLayerDockerfile);
    expect(prompt).toContain('```json');
    expect(prompt).toContain('```');
  });

  it('includes the output instructions', () => {
    const prompt = buildDockerfilePrompt(singleLayerDockerfile);
    expect(prompt).toContain('structured JSON output MUST be the very last thing');
  });

  it('includes status code descriptions', () => {
    const prompt = buildDockerfilePrompt(singleLayerDockerfile);
    expect(prompt).toContain('Status 3 = Fixed');
    expect(prompt).toContain('Status 4 = NoFix');
    expect(prompt).toContain('CVE was resolved in a PR or by base image rebuild');
    expect(prompt).toContain('could not be fixed');
  });

  it('uses nested dockerfile path for multi-layer dockerfile', () => {
    const prompt = buildDockerfilePrompt(multiLayerDockerfile);
    expect(prompt).toContain('services/api/Dockerfile');
    expect(prompt).toContain('4 CodeDefect IDs');
  });

  it('strips CodeDefects down to only ID and PublicID in the prompt JSON', () => {
    const prompt = buildDockerfilePrompt(dockerfileWithFullCodeDefects);
    // ID and PublicID must be present
    expect(prompt).toContain('cd-full-001');
    expect(prompt).toContain('CVE-2024-9999');
    // Extra fields from the full CodeDefect must NOT appear
    expect(prompt).not.toContain('org-secret-123');
    expect(prompt).not.toContain('OrgID');
    expect(prompt).not.toContain('LayerCommand');
    expect(prompt).not.toContain('abc123hash');
    expect(prompt).not.toContain('CreatedAt');
    expect(prompt).not.toContain('UpdatedAt');
  });
});
