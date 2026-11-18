import { describe, it, expect } from 'bun:test';
import { parseTicketOptions } from '../../src/ticket-options';

describe('parseTicketOptions', () => {
  it('requests no ticket unless CREATE_TICKET is true', () => {
    expect(parseTicketOptions({})).toBeUndefined();
    expect(parseTicketOptions({ CREATE_TICKET: 'false', TICKET_LABELS: 'a' })).toBeUndefined();
    expect(parseTicketOptions({ CREATE_TICKET: '' })).toBeUndefined();
  });

  it('requests a ticket with no fields when only CREATE_TICKET is set', () => {
    expect(parseTicketOptions({ CREATE_TICKET: 'true' })).toEqual({});
    expect(parseTicketOptions({ CREATE_TICKET: ' TRUE ' })).toEqual({});
  });

  it('splits and trims the list inputs and drops empty items', () => {
    expect(
      parseTicketOptions({
        CREATE_TICKET: 'true',
        TICKET_LABELS: 'security, container ,,',
        TICKET_COMPONENTS: 'Platform',
      })
    ).toEqual({ Labels: ['security', 'container'], Components: ['Platform'] });
  });

  it('maps every scalar input and omits blank ones', () => {
    expect(
      parseTicketOptions({
        CREATE_TICKET: 'true',
        TICKET_PRIORITY: ' High ',
        TICKET_PARENT: 'SEC-100',
        TICKET_PREFIX: ' team-a ',
        TICKET_ISSUE_TYPE: 'Bug',
        TICKET_ASSIGNEE: 'owner@example.com',
        TICKET_REPORTER: '   ',
      })
    ).toEqual({
      Priority: 'High',
      Parent: 'SEC-100',
      Prefix: 'team-a',
      IssueType: 'Bug',
      AssigneeEmail: 'owner@example.com',
    });
  });
});
