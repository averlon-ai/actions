import { describe, it, expect } from 'bun:test';
import { parseFeedbackFromOutput, parseStructuredAgentOutput } from '../submit-feedback';
import {
  mockClaudeOutputValid,
  mockClaudeOutputMidText,
  mockClaudeOutputNoJson,
  mockClaudeOutputMalformedJson,
  mockClaudeOutputMissingFields,
} from './fixtures';

describe('parseFeedbackFromOutput', () => {
  it('returns empty array for empty string', () => {
    expect(parseFeedbackFromOutput('')).toEqual([]);
  });

  it('parses valid JSON output correctly', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputValid);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ CodeDefectID: 'cd-001', Status: 3, Feedback: '' });
    expect(result[1]).toEqual({
      CodeDefectID: 'cd-002',
      Status: 4,
      Feedback: 'No patch available upstream',
    });
  });

  it('returns empty array when JSON is embedded mid-output (not pure JSON)', () => {
    // parseFeedbackFromOutput does a direct JSON.parse; surrounding text causes parse failure
    const result = parseFeedbackFromOutput(mockClaudeOutputMidText);
    expect(result).toEqual([]);
  });

  it('returns empty array when output contains no JSON', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputNoJson);
    expect(result).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputMalformedJson);
    expect(result).toEqual([]);
  });

  it('filters out entries missing required fields', () => {
    const result = parseFeedbackFromOutput(mockClaudeOutputMissingFields);
    // Only the first entry has both CodeDefectID and Status
    expect(result).toHaveLength(1);
    expect(result[0]?.CodeDefectID).toBe('cd-001');
  });

  it('returns empty array when feedback key is missing from JSON', () => {
    const output = JSON.stringify({ results: [] });
    const result = parseFeedbackFromOutput(output);
    expect(result).toEqual([]);
  });

  it('returns empty array when feedback is not an array', () => {
    const output = JSON.stringify({ feedback: 'not-an-array' });
    const result = parseFeedbackFromOutput(output);
    expect(result).toEqual([]);
  });

  it('parses feedback entries when optional pr fields are present', () => {
    const output = JSON.stringify({
      feedback: [{ CodeDefectID: 'cd-001', Status: 3, Feedback: '' }],
      pr_number: 42,
      pr_url: 'https://github.com/o/r/pull/42',
    });
    expect(parseFeedbackFromOutput(output)).toHaveLength(1);
  });
});

describe('parseStructuredAgentOutput', () => {
  it('returns entries and PR metadata in one parse', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [{ CodeDefectID: 'a', Status: 3, Feedback: '' }],
        pr_number: 12,
        pr_url: 'https://github.com/o/r/pull/12',
      })
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.pr_number).toBe(12);
    expect(parsed.pr_url).toBe('https://github.com/o/r/pull/12');
  });

  it('ignores pr_number and pr_url when not the expected types', () => {
    const parsed = parseStructuredAgentOutput(
      JSON.stringify({
        feedback: [{ CodeDefectID: 'a', Status: 3, Feedback: '' }],
        pr_number: '12',
        pr_url: 123,
      })
    );
    expect(parsed.pr_number).toBeUndefined();
    expect(parsed.pr_url).toBeUndefined();
  });
});
