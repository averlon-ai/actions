import { mock } from 'bun:test';

export const mockCreateOrUpdateIssue = mock(() => Promise.resolve(true));
export const mockCreatePRForIssue = mock(() => Promise.resolve(true));
export const mockCloseIssue = mock(() => Promise.resolve());
export const mockSyncOpenLabeledIssuesToBackend = mock(() => Promise.resolve());

mock.module('@averlon/github-actions-utils', () => ({
  createOrUpdateIssue: mockCreateOrUpdateIssue,
  createPRForIssue: mockCreatePRForIssue,
  closeIssue: mockCloseIssue,
  syncOpenLabeledIssuesToBackend: mockSyncOpenLabeledIssuesToBackend,
  AVERLON_CREATED_LABEL: 'averlon-created',
}));
