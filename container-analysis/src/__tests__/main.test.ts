import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, spyOn, afterAll, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import * as shared from '@averlon/shared';
import { GitImageUpdateKind, type ApiClient, type GitDockerfile } from '@averlon/shared';
import {
  run,
  collectCodeDefects,
  buildDockerfilePrompt,
  describeMapping,
  isActionable,
  baseImageStatus,
  upToDateMessage,
} from '../main';
import {
  emptyDockerfile,
  singleLayerDockerfile,
  multiLayerDockerfile,
  noCodeDefectsDockerfile,
  dockerfileWithFullCodeDefects,
  baseImageUpdateOnlyDockerfile,
  upToDateBaseImageDockerfile,
} from './fixtures';

// the latest push of the same tag: no new tag, the new digest
const rebuildOnly: GitDockerfile = {
  ...baseImageUpdateOnlyDockerfile,
  BaseImageUpdate: {
    CurrentImage: 'docker.io/library/python:3.11-slim',
    Kind: GitImageUpdateKind.Rebuild,
    NewDigest: 'sha256:latest-push',
    FixedCVEs: ['CVE-2026-0001'],
  },
};

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

describe('describeMapping', () => {
  const repo = '123456789012.dkr.ecr.us-west-2.amazonaws.com/app';

  it('says no image was mapped when the response is empty', () => {
    const lines = describeMapping('Dockerfile', repo, []);
    expect(lines[0]).toBe(
      `Averlon could not map Dockerfile (image repository: ${repo}) to an image.`
    );
  });

  it('omits the image repository when none was given', () => {
    const lines = describeMapping('Dockerfile', '', []);
    expect(lines[0]).toBe('Averlon could not map Dockerfile to an image.');
  });

  it('names the mapped image and says nothing to upgrade', () => {
    const lines = describeMapping('Dockerfile', repo, [
      { ...emptyDockerfile, ImageID: 'img-1', CloudID: 'cloud-1' },
    ]);
    expect(lines).toEqual([
      `Averlon mapped Dockerfile to ${repo} (image ID img-1, cloud cloud-1).`,
      'No package upgrades are recommended for this image.',
    ]);
  });

  it('falls back to the repository name from the response', () => {
    const lines = describeMapping('Dockerfile', '', [
      { ...emptyDockerfile, ImageRepository: { RepositoryName: 'app' } },
    ]);
    expect(lines[0]).toBe('Averlon mapped Dockerfile to app.');
  });

  it('describes the base image update', () => {
    expect(describeMapping('Dockerfile', repo, [baseImageUpdateOnlyDockerfile])).toEqual([
      `Averlon mapped Dockerfile to ${repo}.`,
      'No package upgrades are recommended for this image.',
      'Base image update: docker.io/library/python:3.11-slim to tag 3.11.18-slim, fixes 1 CVE(s).',
    ]);
    expect(describeMapping('Dockerfile', repo, [rebuildOnly])[2]).toBe(
      'Base image update: rebuild on the latest push of docker.io/library/python:3.11-slim, fixes 1 CVE(s).'
    );
    expect(describeMapping('Dockerfile', repo, [upToDateBaseImageDockerfile])[2]).toBe(
      'Base image 945236499471.dkr.ecr.us-west-2.amazonaws.com/platform/python-base:1.1.0 is up to date.'
    );
  });

  it('counts packages to upgrade', () => {
    const lines = describeMapping('Dockerfile', repo, [singleLayerDockerfile]);
    expect(lines[1]).toBe('Found 1 package(s) to upgrade in 1 layer(s).');
  });
});

describe('isActionable', () => {
  it('is false with no packages and no base image update', () => {
    expect(isActionable(emptyDockerfile)).toBe(false);
  });

  it('is true with packages', () => {
    expect(isActionable(singleLayerDockerfile)).toBe(true);
  });

  it('is true with only a base image update that fixes CVEs', () => {
    expect(isActionable(baseImageUpdateOnlyDockerfile)).toBe(true);
    expect(isActionable(rebuildOnly)).toBe(true);
  });

  it('is false with a base image update that fixes no CVE', () => {
    expect(
      isActionable({
        ...baseImageUpdateOnlyDockerfile,
        BaseImageUpdate: { ...baseImageUpdateOnlyDockerfile.BaseImageUpdate!, FixedCVEs: [] },
      })
    ).toBe(false);
  });
});

describe('buildDockerfilePrompt with only a base image update', () => {
  it('keeps the base image update in the data', () => {
    const prompt = buildDockerfilePrompt(baseImageUpdateOnlyDockerfile);
    expect(prompt).toContain('"BaseImageUpdate"');
    expect(prompt).toContain('"NewTag": "3.11.18-slim"');
    expect(prompt).toContain('There are 0 CodeDefect IDs');
  });
});

describe('baseImageStatus', () => {
  it('is none with no base image update', () => {
    expect(baseImageStatus(singleLayerDockerfile)).toBe('none');
    expect(baseImageStatus(undefined)).toBe('none');
  });

  it('is up-to-date for an up to date base image', () => {
    expect(baseImageStatus(upToDateBaseImageDockerfile)).toBe('up-to-date');
  });

  it('reads the kind', () => {
    expect(baseImageStatus(baseImageUpdateOnlyDockerfile)).toBe('change-from');
    expect(baseImageStatus(rebuildOnly)).toBe('rebuild');
  });

  it('is none for an unknown kind', () => {
    const update = baseImageUpdateOnlyDockerfile.BaseImageUpdate!;
    expect(
      baseImageStatus({
        ...baseImageUpdateOnlyDockerfile,
        BaseImageUpdate: { ...update, Kind: undefined },
      })
    ).toBe('none');
  });
});

describe('isActionable with an up to date base image', () => {
  it('is false: there is nothing to remediate', () => {
    expect(isActionable(upToDateBaseImageDockerfile)).toBe(false);
  });
});

describe('upToDateMessage', () => {
  it('names the Dockerfile and the base image, with the reasoning', () => {
    expect(upToDateMessage(upToDateBaseImageDockerfile)).toBe(
      'base_image_updates/orders/Dockerfile: base image 945236499471.dkr.ecr.us-west-2.amazonaws.com/platform/python-base:1.1.0 is up to date, no newer base image was found. 1.1.0 is the latest version.'
    );
  });
});

describe('run', () => {
  const getContainerRecommendations = mock(() =>
    Promise.resolve({ Dockerfiles: [] as GitDockerfile[] })
  );
  let setOutput: ReturnType<typeof spyOn>;
  let notice: ReturnType<typeof spyOn>;
  let setFailed: ReturnType<typeof spyOn>;
  let createApiClient: ReturnType<typeof spyOn>;
  let workDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  // @actions/core keeps the first summary file path that it reads, so all the
  // tests of the process write to one file
  const summaryFile = path.join(os.tmpdir(), `container-analysis-summary-${process.pid}.md`);

  afterAll(() => {
    fs.rmSync(summaryFile, { force: true });
  });

  function outputsOf(): Record<string, string> {
    return Object.fromEntries(setOutput.mock.calls as [string, string][]);
  }

  function summary(): string {
    return fs.readFileSync(summaryFile, 'utf8');
  }

  async function runWith(dockerfiles: GitDockerfile[]): Promise<void> {
    getContainerRecommendations.mockImplementation(() =>
      Promise.resolve({ Dockerfiles: dockerfiles })
    );
    await run();
    expect(setFailed).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    originalEnv = { ...process.env };
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'container-analysis-'));
    const dockerfile = path.join(workDir, 'Dockerfile');
    fs.writeFileSync(dockerfile, 'FROM docker.io/library/python:3.11-slim\n');
    fs.writeFileSync(summaryFile, '');
    process.env['AVERLON_API_KEY'] = 'key';
    process.env['AVERLON_API_SECRET'] = 'secret';
    process.env['INPUT_DOCKERFILE'] = dockerfile;
    process.env['GITHUB_STEP_SUMMARY'] = summaryFile;

    getContainerRecommendations.mockClear();
    createApiClient = spyOn(shared, 'createApiClient').mockImplementation(
      () => ({ getContainerRecommendations }) as unknown as ApiClient
    );
    setOutput = spyOn(core, 'setOutput').mockImplementation(() => {});
    notice = spyOn(core, 'notice').mockImplementation(() => {});
    setFailed = spyOn(core, 'setFailed').mockImplementation(() => {});
    spyOn(core, 'setSecret').mockImplementation(() => {});
    spyOn(core, 'info').mockImplementation(() => {});
    spyOn(core, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    createApiClient.mockRestore();
    setOutput.mockRestore();
    notice.mockRestore();
    setFailed.mockRestore();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('reports an up to date base image, with no remediation', async () => {
    await runWith([upToDateBaseImageDockerfile]);

    const outputs = outputsOf();
    expect(outputs['base-image-status']).toBe('up-to-date');
    expect(outputs['has-recommendations']).toBe('false');
    const message = upToDateMessage(upToDateBaseImageDockerfile);
    expect(notice).toHaveBeenCalledWith(message);
    expect(summary()).toContain('Base image is up to date');
    expect(summary()).toContain(message);
  });

  it('remediates a rebuild with no packages', async () => {
    await runWith([rebuildOnly]);

    const outputs = outputsOf();
    expect(outputs['base-image-status']).toBe('rebuild');
    expect(outputs['has-recommendations']).toBe('true');
    expect(outputs['prompt']).toContain('"Kind": 2');
    expect(notice).not.toHaveBeenCalled();
    expect(summary()).toBe('');
  });

  it('remediates a base image change with no packages', async () => {
    await runWith([baseImageUpdateOnlyDockerfile]);

    const outputs = outputsOf();
    expect(outputs['base-image-status']).toBe('change-from');
    expect(outputs['has-recommendations']).toBe('true');
  });

  it('reports none when no image was mapped', async () => {
    await runWith([]);

    const outputs = outputsOf();
    expect(outputs['base-image-status']).toBe('none');
    expect(outputs['has-recommendations']).toBe('false');
    expect(notice).not.toHaveBeenCalled();
  });
});
