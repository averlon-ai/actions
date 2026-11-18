export const mockClaudeOutputValid = JSON.stringify({
  feedback: [
    { CodeDefectID: 'cd-001', Status: 3, Feedback: '' },
    { CodeDefectID: 'cd-002', Status: 4, Feedback: 'No patch available upstream' },
  ],
});

export const mockClaudeOutputMidText =
  'Some explanation text here\n\n' +
  JSON.stringify({
    feedback: [{ CodeDefectID: 'cd-001', Status: 3, Feedback: '' }],
  }) +
  '\n\nMore text after';

export const mockClaudeOutputNoJson =
  'I attempted to fix the vulnerability but could not find a patch.';

export const mockClaudeOutputMalformedJson = 'Here is my output: { feedback: [broken json';

export const mockClaudeOutputMissingFields = JSON.stringify({
  feedback: [
    { CodeDefectID: 'cd-001', Status: 3, Feedback: '' },
    { Status: 4, Feedback: 'missing CodeDefectID' },
    { CodeDefectID: 'cd-003' }, // missing Status
  ],
});
