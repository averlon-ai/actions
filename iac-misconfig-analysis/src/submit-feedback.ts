import { GitIssueType } from '@averlon/shared';
import { runSubmitFeedback, type AgentPrRegistration } from '@averlon/claude-agent-utils';
import { AVERLON_MISCONFIG_ANALYSIS_LABEL } from './constants';

export const IAC_PR_REGISTRATION: AgentPrRegistration = {
  name: 'IaC',
  label: AVERLON_MISCONFIG_ANALYSIS_LABEL,
  type: GitIssueType.IaC,
  titlePrefix: 'IaC Remediation',
};

function run(): Promise<void> {
  return runSubmitFeedback(IAC_PR_REGISTRATION);
}

export { run };

if (require.main === module) {
  run();
}
