import * as core from '@actions/core';
import {
  CodeDefectStatus,
  CodeDefectType,
  type ApiClient,
  type CodeDefect,
  type IssueSeverityEnum,
  type TerraformResource,
} from '@averlon/shared';
import { FEEDBACK_REQUEST_INTERVAL_MS } from '@averlon/claude-agent-utils';
import { writeCodeDefectIdsFile } from '@averlon/claude-agent-utils/code-defect-ids';
import { ALLOWED_BASE_TOOLS, FEEDBACK_JSON_SCHEMA } from '@averlon/claude-agent-utils/constants';
import { MCP_TOOLS } from './constants';

/** Caps one remediation text, so that one long record cannot fill the prompt. */
export const MAX_REMEDIATION_DATA_CHARS = 8000;

/**
 * claude-code-action passes the prompt in the PROMPT environment variable and,
 * JSON-escaped, in ALL_INPUTS, and Linux limits one variable to 128 KiB. The
 * JSON-escaped prompt stays under this size, which leaves room for the other
 * inputs in ALL_INPUTS. Code defects that do not fit are not sent and keep
 * their status, for the next run.
 */
export const MAX_PROMPT_BYTES = 100_000;

/** The size of the prompt in ALL_INPUTS, where it is JSON-escaped */
export function promptBytes(prompt: string): number {
  return Buffer.byteLength(JSON.stringify(prompt));
}

/** The plan address that correlation matched to each cloud resource with misconfigurations. */
export function collectPlanAddresses(resources: TerraformResource[]): Map<string, string> {
  const addresses = new Map<string, string>();
  for (const resource of resources) {
    const resourceId = resource.Asset?.ResourceID;
    if (resourceId && resource.Issues?.length && !addresses.has(resourceId)) {
      addresses.set(resourceId, resource.ID ?? '');
    }
  }
  return addresses;
}

/** The code defect with the fields the skill uses */
function toPromptCodeDefect(cd: CodeDefect): CodeDefect {
  return {
    ID: cd.ID,
    Type: cd.Type,
    PublicID: cd.PublicID,
    Title: cd.Title,
    Severity: cd.Severity,
    IssueIDs: cd.IssueIDs,
    Remediations: cd.Remediations?.map(({ Type, Description, Data }) => ({
      Type,
      Description,
      Data:
        Data && Data.length > MAX_REMEDIATION_DATA_CHARS
          ? `${Data.slice(0, MAX_REMEDIATION_DATA_CHARS)}…`
          : Data,
    })),
    Asset: cd.Asset,
  };
}

/**
 * The code defects for the prompt, in server order, with the fields the skill
 * uses, while the whole prompt stays under MAX_PROMPT_BYTES. If the first code
 * defect is too large alone, it is sent without the remediation details; if it
 * is still too large, nothing is sent.
 */
export function selectPromptCodeDefects(params: {
  accountId: string;
  codeDefects: CodeDefect[];
  planAddresses: Map<string, string>;
}): CodeDefect[] {
  const fits = (codeDefects: CodeDefect[]): boolean =>
    promptBytes(buildIaCPrompt({ ...params, codeDefects })) <= MAX_PROMPT_BYTES;

  const selected: CodeDefect[] = [];
  for (const cd of params.codeDefects) {
    let candidate = toPromptCodeDefect(cd);
    if (!fits([...selected, candidate])) {
      if (selected.length > 0) {
        break;
      }
      candidate = {
        ...candidate,
        Remediations: candidate.Remediations?.map(({ Type, Description }) => ({
          Type,
          Description,
        })),
      };
      if (!fits([candidate])) {
        break;
      }
      core.warning(
        `Code defect ${cd.ID} is too large for the prompt; it is sent without the remediation details`
      );
    }
    selected.push(candidate);
  }
  return selected;
}

/**
 * Builds a prompt string for the /remediate-iac skill. The skill takes the
 * AccountID of the request, the plan address of each asset, and the
 * CodeDefects of the response.
 */
export function buildIaCPrompt(params: {
  accountId: string;
  codeDefects: CodeDefect[];
  planAddresses: Map<string, string>;
}): string {
  const { accountId, codeDefects, planAddresses } = params;
  const assetAddresses: Record<string, string> = {};
  for (const cd of codeDefects) {
    const resourceId = cd.Asset?.ResourceID;
    const address = resourceId ? planAddresses.get(resourceId) : undefined;
    if (resourceId && address) {
      assetAddresses[resourceId] = address;
    }
  }
  const json = JSON.stringify(
    {
      AccountID: accountId,
      ...(Object.keys(assetAddresses).length ? { PlanAddresses: assetAddresses } : {}),
      CodeDefects: codeDefects,
    },
    null,
    2
  );

  return `Use /remediate-iac skill to resolve the misconfigurations below in the Terraform code of this repository and create respective PRs.

The data includes CodeDefects with IDs. Your structured output must include a
"feedback" array with one entry per CodeDefect ID. For each entry:
- Status ${CodeDefectStatus.Fixed} = Fixed (the misconfiguration was resolved in a PR)
- Status ${CodeDefectStatus.NoFix} = NoFix (no change was made)
- Feedback = empty string for Fixed; concise reason for NoFix

There are ${codeDefects.length} CodeDefect IDs to report on. Every one MUST appear in the output.

If you created any PRs, list EVERY one of them in "pull_requests", an array of
{"pr_number": <integer>, "pr_url": <string>} objects.

For each Fixed entry, set "pr_url" to the URL of the PR that fixed it, exactly as
listed in "pull_requests". Leave "pr_url" out for NoFix entries.

IMPORTANT: The structured JSON output MUST be the very last thing you produce.
Do NOT output any additional text, summary, or commentary after emitting the structured JSON.
Once you emit the JSON, stop immediately.

Here is the IaC code defect data:

\`\`\`json
${json}
\`\`\``;
}

/**
 * Moves the code defects of the prompt to InProgress, so that other runs skip
 * them while the agent works on them. A failed move is logged; the agent still
 * gets the code defect. Requests go one at a time with a short wait between them.
 */
export async function claimCodeDefects(params: {
  apiClient: ApiClient;
  codeDefects: CodeDefect[];
  intervalMs?: number | undefined;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  const {
    apiClient,
    codeDefects,
    intervalMs = FEEDBACK_REQUEST_INTERVAL_MS,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = params;

  let claimed = 0;
  for (const [index, cd] of codeDefects.entries()) {
    if (index > 0 && intervalMs > 0) {
      await wait(intervalMs);
    }
    try {
      await apiClient.updateCodeDefectFeedback({
        CodeDefectID: cd.ID ?? '',
        Status: CodeDefectStatus.InProgress,
        // the request also sets the feedback, so send the current one
        Feedback: cd.Feedback ?? '',
      });
      claimed++;
    } catch (err) {
      core.warning(
        `Code defect ${cd.ID} was not moved to InProgress: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  core.info(`Moved ${claimed} of ${codeDefects.length} code defect(s) to InProgress.`);
}

export interface ClaudeModeParams {
  apiClient: ApiClient;
  resources: TerraformResource[];
  accountId: string;
  severityFilters?: IssueSeverityEnum[] | undefined;
  disableWebSearch: boolean;
  /** Wait between the InProgress requests; FEEDBACK_REQUEST_INTERVAL_MS by default. */
  claimIntervalMs?: number | undefined;
}

/**
 * Gets the code defects of the correlated resources, moves the code defects
 * of the prompt to InProgress, and sets the outputs that the Run Coding Agent
 * and Submit Agent Feedback steps use.
 */
export async function runClaudeMode(params: ClaudeModeParams): Promise<void> {
  const { apiClient, resources, accountId, severityFilters, disableWebSearch } = params;

  const planAddresses = collectPlanAddresses(resources);
  if (planAddresses.size === 0) {
    core.info('No plan resources with misconfigurations. Nothing to remediate.');
    core.setOutput('has-findings', 'false');
    return;
  }

  core.info(
    `Calling Averlon API for the code defects of ${planAddresses.size} resource(s) in account ${accountId}...`
  );
  const response = await apiClient.getCodeDefectRecommendations({
    Type: CodeDefectType.IaC,
    AccountID: accountId,
    ResourceIDs: [...planAddresses.keys()],
    ...(severityFilters?.length ? { Severities: severityFilters } : {}),
    // only the code defects of the prompt go to InProgress, below
    CreateAsPending: true,
  });

  const codeDefects = (response.CodeDefects ?? []).filter(cd => cd.ID);
  if (codeDefects.length === 0) {
    core.info('No code defects to remediate (fixed, or in cooldown). Nothing to remediate.');
    core.setOutput('has-findings', 'false');
    return;
  }

  const promptCodeDefects = selectPromptCodeDefects({ accountId, codeDefects, planAddresses });
  if (promptCodeDefects.length === 0) {
    core.warning(
      `Code defect ${codeDefects[0]?.ID} is too large for the prompt. Nothing to remediate.`
    );
    core.setOutput('has-findings', 'false');
    return;
  }
  core.info(
    promptCodeDefects.length < codeDefects.length
      ? `Found ${codeDefects.length} code defect(s); the prompt has room for ${promptCodeDefects.length}, the next run gets the others.`
      : `Found ${codeDefects.length} code defect(s) to remediate.`
  );

  // Write the IDs first, so that the feedback step sets every code defect the
  // agent does not report on back to Pending, also when a later step fails.
  const promptIds = new Set(promptCodeDefects.map(cd => cd.ID));
  const claimed = codeDefects.filter(cd => promptIds.has(cd.ID));
  core.setOutput('code-defect-ids-file', writeCodeDefectIdsFile(claimed.map(cd => cd.ID ?? '')));
  await claimCodeDefects({ apiClient, codeDefects: claimed, intervalMs: params.claimIntervalMs });

  const tools = [...ALLOWED_BASE_TOOLS];
  if (!disableWebSearch) {
    tools.push('WebSearch');
  }

  core.setOutput('has-findings', 'true');
  core.setOutput(
    'prompt',
    buildIaCPrompt({ accountId, codeDefects: promptCodeDefects, planAddresses })
  );
  core.setOutput('json-schema', FEEDBACK_JSON_SCHEMA);
  core.setOutput('allowed-tools', [...tools, ...MCP_TOOLS].join(','));
}
