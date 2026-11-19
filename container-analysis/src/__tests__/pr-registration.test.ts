import { describe, it, expect } from 'bun:test';
import { GitIssueType } from '@averlon/shared';
import { CONTAINER_PR_REGISTRATION } from '../submit-feedback';

describe('CONTAINER_PR_REGISTRATION', () => {
  it('labels and registers container PRs', () => {
    expect(CONTAINER_PR_REGISTRATION).toEqual({
      name: 'container',
      label: 'averlon-container-analysis',
      type: GitIssueType.Container,
      titlePrefix: 'Container Remediation',
    });
  });
});
