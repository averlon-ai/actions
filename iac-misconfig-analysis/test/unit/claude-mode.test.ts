import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, spyOn, beforeEach, afterEach, mock } from 'bun:test';
import * as core from '@actions/core';
import {
  CodeDefectStatus,
  CodeDefectType,
  IssueSeverityEnum,
  type ApiClient,
  type CodeDefect,
} from '@averlon/shared';
import {
  buildIaCPrompt,
  claimCodeDefects,
  collectPlanAddresses,
  MAX_PROMPT_BYTES,
  MAX_REMEDIATION_DATA_CHARS,
  promptBytes,
  runClaudeMode,
  selectPromptCodeDefects,
} from '../../src/claude-mode';
import { MCP_TOOLS } from '../../src/constants';

const BUCKET = 'arn:aws:s3:::logs';
const ROLE = 'arn:aws:iam::123456789012:role/admin';

const resources = [
  { ID: 'aws_s3_bucket.logs', Asset: { ResourceID: BUCKET }, Issues: [{ ID: 'i-1' }] },
  { ID: 'aws_iam_role.admin', Asset: { ResourceID: ROLE }, Issues: [{ ID: 'i-2' }] },
  { ID: 'aws_sqs_queue.jobs', Asset: { ResourceID: 'arn:aws:sqs:::jobs' }, Issues: [] },
  { ID: 'aws_sns_topic.alerts', Issues: [{ ID: 'i-3' }] },
];

const codeDefects: CodeDefect[] = [
  {
    ID: 'cd-1',
    OrgID: 'org-1',
    Status: 2,
    CreatedAt: '2026-10-01T00:00:00Z',
    Type: CodeDefectType.IaC,
    PublicID: 'AVN-AWS-0089',
    Title: 'S3 bucket does not have logging enabled',
    Severity: IssueSeverityEnum.High,
    IssueIDs: ['i-1'],
    Remediations: [{ ID: 'r-1', Type: 8, RenderType: 1, Description: 'Enable logging', Data: 'x' }],
    Asset: { ID: 'a-1', ResourceID: BUCKET, Name: 'logs' },
  },
  {
    ID: 'cd-2',
    PublicID: 'AVN-AWS-0057',
    Feedback: 'The role is not in this repository',
    Asset: { ResourceID: ROLE },
  },
];

function bigCodeDefect(id: string): CodeDefect {
  return {
    ID: id,
    Asset: { ResourceID: BUCKET },
    Remediations: [1, 2, 3].map(() => ({ Data: 'a'.repeat(MAX_REMEDIATION_DATA_CHARS) })),
  };
}

function outputsOf(setOutput: ReturnType<typeof spyOn>): Record<string, string> {
  return Object.fromEntries(setOutput.mock.calls as [string, string][]);
}

describe('collectPlanAddresses', () => {
  it('maps each cloud resource that has issues to its plan address', () => {
    expect(collectPlanAddresses(resources)).toEqual(
      new Map([
        [BUCKET, 'aws_s3_bucket.logs'],
        [ROLE, 'aws_iam_role.admin'],
      ])
    );
  });
});

describe('selectPromptCodeDefects', () => {
  const planAddresses = collectPlanAddresses(resources);
  const select = (defects: CodeDefect[]) =>
    selectPromptCodeDefects({ accountId: '123456789012', codeDefects: defects, planAddresses });
  const sizeOf = (defects: CodeDefect[]) =>
    promptBytes(buildIaCPrompt({ accountId: '123456789012', codeDefects: defects, planAddresses }));

  beforeEach(() => {
    spyOn(core, 'warning').mockImplementation(() => {});
  });

  it('keeps the fields the skill uses', () => {
    expect(select(codeDefects)[0]).toEqual({
      ID: 'cd-1',
      Type: CodeDefectType.IaC,
      PublicID: 'AVN-AWS-0089',
      Title: 'S3 bucket does not have logging enabled',
      Severity: IssueSeverityEnum.High,
      IssueIDs: ['i-1'],
      Remediations: [{ Type: 8, Description: 'Enable logging', Data: 'x' }],
      Asset: { ID: 'a-1', ResourceID: BUCKET, Name: 'logs' },
    });
  });

  it('truncates a long remediation text', () => {
    const [selected] = select([
      { ID: 'cd-3', Remediations: [{ Data: 'a'.repeat(MAX_REMEDIATION_DATA_CHARS + 100) }] },
    ]);

    expect(selected?.Remediations?.[0]?.Data).toBe(`${'a'.repeat(MAX_REMEDIATION_DATA_CHARS)}…`);
  });

  it('stops at the size limit of the whole prompt, in server order', () => {
    const many = Array.from({ length: 10 }, (_, i) => bigCodeDefect(`cd-${i}`));
    const selected = select(many);

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThan(many.length);
    expect(selected.map(cd => cd.ID)).toEqual(many.slice(0, selected.length).map(cd => cd.ID));
    expect(sizeOf(selected)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(sizeOf(many.slice(0, selected.length + 1).map(cd => select([cd])[0]!))).toBeGreaterThan(
      MAX_PROMPT_BYTES
    );
  });

  it('counts the escaping of the prompt', () => {
    // quotes are escaped once in the JSON of the prompt and again in ALL_INPUTS
    const quoted = Array.from({ length: 10 }, (_, i) => ({
      ...bigCodeDefect(`cd-${i}`),
      Remediations: [{ Data: '"'.repeat(MAX_REMEDIATION_DATA_CHARS) }],
    }));
    const selected = select(quoted);

    expect(selected.length).toBeGreaterThan(0);
    expect(sizeOf(selected)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
    expect(
      Buffer.byteLength(buildIaCPrompt({ accountId: '1', codeDefects: selected, planAddresses }))
    ).toBeLessThan(MAX_PROMPT_BYTES);
  });

  it('sends a first code defect that is too large without the remediation details', () => {
    const huge: CodeDefect = {
      ID: 'cd-huge',
      Remediations: Array.from({ length: 20 }, () => ({
        Description: 'Enable logging',
        Data: 'a'.repeat(MAX_REMEDIATION_DATA_CHARS),
      })),
    };

    const selected = select([huge, codeDefects[0]!]);

    expect(selected.map(cd => cd.ID)).toEqual(['cd-huge', 'cd-1']);
    expect(selected[0]?.Remediations).toEqual(
      Array.from({ length: 20 }, () => ({ Description: 'Enable logging' }))
    );
    expect(sizeOf(selected)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
  });

  it('sends nothing when the first code defect is too large without them', () => {
    expect(
      select([{ ID: 'cd-huge', Title: 'a'.repeat(MAX_PROMPT_BYTES) }, codeDefects[0]!])
    ).toEqual([]);
  });
});

describe('buildIaCPrompt', () => {
  const planAddresses = collectPlanAddresses(resources);

  function promptJson(prompt: string): unknown {
    return JSON.parse(prompt.split('```json\n')[1]!.split('\n```')[0]!);
  }

  it('embeds the input that the skill expects', () => {
    const prompt = buildIaCPrompt({ accountId: '123456789012', codeDefects, planAddresses });

    expect(prompt).toContain('/remediate-iac');
    expect(prompt).toContain('2 CodeDefect IDs');
    expect(prompt).toContain('"pr_number"');
    expect(promptJson(prompt)).toEqual({
      AccountID: '123456789012',
      PlanAddresses: { [BUCKET]: 'aws_s3_bucket.logs', [ROLE]: 'aws_iam_role.admin' },
      CodeDefects: codeDefects,
    });
  });

  it('sends only the plan addresses of the assets in the prompt', () => {
    const prompt = buildIaCPrompt({
      accountId: '1',
      codeDefects: [codeDefects[1]!],
      planAddresses,
    });

    expect(promptJson(prompt)).toMatchObject({ PlanAddresses: { [ROLE]: 'aws_iam_role.admin' } });
    expect(prompt).not.toContain('aws_s3_bucket.logs');
  });

  it('leaves out PlanAddresses when no asset has a plan address', () => {
    const prompt = buildIaCPrompt({ accountId: '1', codeDefects, planAddresses: new Map() });

    expect(promptJson(prompt)).toEqual({ AccountID: '1', CodeDefects: codeDefects });
  });
});

describe('claimCodeDefects', () => {
  it('moves each code defect to InProgress with its current feedback, one at a time', async () => {
    spyOn(core, 'info').mockImplementation(() => {});
    const updateCodeDefectFeedback = mock(() => Promise.resolve({}));
    const waits: number[] = [];

    await claimCodeDefects({
      apiClient: { updateCodeDefectFeedback } as unknown as ApiClient,
      codeDefects,
      wait: ms => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    expect(updateCodeDefectFeedback.mock.calls).toEqual([
      [{ CodeDefectID: 'cd-1', Status: CodeDefectStatus.InProgress, Feedback: '' }],
      [
        {
          CodeDefectID: 'cd-2',
          Status: CodeDefectStatus.InProgress,
          Feedback: 'The role is not in this repository',
        },
      ],
    ]);
    expect(waits).toEqual([200]);
  });
});

describe('runClaudeMode', () => {
  const getCodeDefectRecommendations = mock(() => Promise.resolve({ CodeDefects: codeDefects }));
  const updateCodeDefectFeedback = mock(() => Promise.resolve({}));
  const apiClient = {
    getCodeDefectRecommendations,
    updateCodeDefectFeedback,
  } as unknown as ApiClient;
  let setOutput: ReturnType<typeof spyOn>;
  let warning: ReturnType<typeof spyOn>;

  const params = {
    apiClient,
    resources,
    accountId: '123456789012',
    severityFilters: [IssueSeverityEnum.Critical, IssueSeverityEnum.High],
    disableWebSearch: false,
    claimIntervalMs: 0,
  };

  // the code defects that the run moved to InProgress
  function claimedIds(): string[] {
    return (updateCodeDefectFeedback.mock.calls as unknown as [{ CodeDefectID: string }][]).map(
      ([req]) => req.CodeDefectID
    );
  }

  let runnerTemp: string;
  let originalRunnerTemp: string | undefined;

  // the IDs that the feedback step reads
  function codeDefectIds(): string {
    return fs.readFileSync(outputsOf(setOutput)['code-defect-ids-file']!, 'utf8');
  }

  beforeEach(() => {
    getCodeDefectRecommendations.mockClear();
    updateCodeDefectFeedback.mockClear();
    setOutput = spyOn(core, 'setOutput').mockImplementation(() => {});
    spyOn(core, 'info').mockImplementation(() => {});
    warning = spyOn(core, 'warning').mockImplementation(() => {});
    originalRunnerTemp = process.env['RUNNER_TEMP'];
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-temp-'));
    process.env['RUNNER_TEMP'] = runnerTemp;
  });

  afterEach(() => {
    setOutput.mockRestore();
    if (originalRunnerTemp === undefined) {
      delete process.env['RUNNER_TEMP'];
    } else {
      process.env['RUNNER_TEMP'] = originalRunnerTemp;
    }
    fs.rmSync(runnerTemp, { recursive: true, force: true });
  });

  it('requests the IaC code defects of the correlated resources in the cloud account', async () => {
    await runClaudeMode(params);

    expect(getCodeDefectRecommendations).toHaveBeenCalledWith({
      Type: CodeDefectType.IaC,
      AccountID: '123456789012',
      ResourceIDs: [BUCKET, ROLE],
      Severities: [IssueSeverityEnum.Critical, IssueSeverityEnum.High],
      CreateAsPending: true,
    });
    const outputs = outputsOf(setOutput);
    expect(outputs['has-findings']).toBe('true');
    expect(outputs['code-defect-ids-file']!.startsWith(runnerTemp)).toBe(true);
    expect(codeDefectIds()).toBe('cd-1,cd-2');
    expect(claimedIds()).toEqual(['cd-1', 'cd-2']);
    expect(outputs['prompt']).toContain('/remediate-iac');
    expect(JSON.parse(outputs['json-schema']!).required).toEqual(['feedback']);
    expect(outputs['allowed-tools']!.split(',')).toEqual(expect.arrayContaining(MCP_TOOLS));
    expect(outputs['allowed-tools']).toContain('WebSearch');
  });

  it('moves only the code defects of the prompt to InProgress, and reports on them', async () => {
    const many = Array.from({ length: 10 }, (_, i) => bigCodeDefect(`cd-${i}`));
    getCodeDefectRecommendations.mockImplementationOnce(() =>
      Promise.resolve({ CodeDefects: many })
    );

    await runClaudeMode(params);

    const outputs = outputsOf(setOutput);
    const sent = selectPromptCodeDefects({
      accountId: params.accountId,
      codeDefects: many,
      planAddresses: collectPlanAddresses(resources),
    });
    expect(sent.length).toBeLessThan(many.length);
    expect(codeDefectIds()).toBe(sent.map(cd => cd.ID).join(','));
    expect(claimedIds()).toEqual(sent.map(cd => cd.ID!));
    expect(outputs['prompt']).toContain(`${sent.length} CodeDefect IDs`);
    expect(outputs['prompt']).not.toContain('"cd-9"');
    expect(promptBytes(outputs['prompt']!)).toBeLessThanOrEqual(MAX_PROMPT_BYTES);
  });

  it('runs no agent when the first code defect does not fit in the prompt', async () => {
    getCodeDefectRecommendations.mockImplementationOnce(() =>
      Promise.resolve({ CodeDefects: [{ ID: 'cd-huge', Title: 'a'.repeat(MAX_PROMPT_BYTES) }] })
    );

    await runClaudeMode(params);

    const outputs = outputsOf(setOutput);
    expect(outputs['has-findings']).toBe('false');
    expect(outputs['prompt']).toBeUndefined();
    expect(outputs['code-defect-ids-file']).toBeUndefined();
    expect(updateCodeDefectFeedback).not.toHaveBeenCalled();
  });

  it('still runs the agent when a code defect cannot be moved to InProgress', async () => {
    updateCodeDefectFeedback.mockImplementationOnce(() => Promise.reject(new Error('503')));

    await runClaudeMode(params);

    expect(claimedIds()).toEqual(['cd-1', 'cd-2']);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('cd-1 was not moved'));
    expect(outputsOf(setOutput)['has-findings']).toBe('true');
    expect(codeDefectIds()).toBe('cd-1,cd-2');
  });

  it('leaves out WebSearch when it is disabled', async () => {
    await runClaudeMode({ ...params, disableWebSearch: true });

    expect(outputsOf(setOutput)['allowed-tools']).not.toContain('WebSearch');
  });

  it('sends no severities when there is no filter', async () => {
    await runClaudeMode({ ...params, severityFilters: undefined });

    expect(getCodeDefectRecommendations).toHaveBeenCalledWith(
      expect.not.objectContaining({ Severities: expect.anything() })
    );
  });

  it('calls no API when no resource has issues', async () => {
    await runClaudeMode({ ...params, resources: [resources[2]!] });

    expect(getCodeDefectRecommendations).not.toHaveBeenCalled();
    expect(outputsOf(setOutput)).toEqual({ 'has-findings': 'false' });
  });

  it('has no findings when the server returns no code defects', async () => {
    getCodeDefectRecommendations.mockImplementationOnce(() => Promise.resolve({} as never));

    await runClaudeMode(params);

    const outputs = outputsOf(setOutput);
    expect(outputs['has-findings']).toBe('false');
    expect(outputs['code-defect-ids-file']).toBeUndefined();
    expect(outputs['prompt']).toBeUndefined();
    expect(updateCodeDefectFeedback).not.toHaveBeenCalled();
  });
});
