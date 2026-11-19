import { GitIssueType } from '@averlon/shared';
import { runSubmitFeedback, type AgentPrRegistration } from '@averlon/claude-agent-utils';
import { AVERLON_CONTAINER_LABEL } from './constants';

export const CONTAINER_PR_REGISTRATION: AgentPrRegistration = {
  name: 'container',
  label: AVERLON_CONTAINER_LABEL,
  type: GitIssueType.Container,
  titlePrefix: 'Container Remediation',
};

function run(): Promise<void> {
  return runSubmitFeedback(CONTAINER_PR_REGISTRATION);
}

export { run };

if (require.main === module) {
  run();
}
