import type { TicketRequest } from '@averlon/shared';

/** Split a comma-separated input into trimmed, non-empty items. */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '');
}

/**
 * Read the ticket inputs, passed to the step as environment variables.
 * Returns undefined unless CREATE_TICKET is "true", so by default no ticket is requested.
 */
export function parseTicketOptions(
  env: NodeJS.ProcessEnv = process.env
): TicketRequest | undefined {
  if (env['CREATE_TICKET']?.trim().toLowerCase() !== 'true') {
    return undefined;
  }

  const ticket: TicketRequest = {};
  const labels = splitList(env['TICKET_LABELS']);
  if (labels.length > 0) {
    ticket.Labels = labels;
  }
  const components = splitList(env['TICKET_COMPONENTS']);
  if (components.length > 0) {
    ticket.Components = components;
  }

  const scalars: [keyof TicketRequest, string | undefined][] = [
    ['Priority', env['TICKET_PRIORITY']],
    ['Parent', env['TICKET_PARENT']],
    ['Prefix', env['TICKET_PREFIX']],
    ['IssueType', env['TICKET_ISSUE_TYPE']],
    ['AssigneeEmail', env['TICKET_ASSIGNEE']],
    ['ReporterEmail', env['TICKET_REPORTER']],
  ];
  for (const [field, value] of scalars) {
    const trimmed = value?.trim();
    if (trimmed) {
      (ticket as Record<string, unknown>)[field] = trimmed;
    }
  }
  return ticket;
}
