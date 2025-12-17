import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { getInputSafe, parseBoolean } from '../../src/input-utils';

// Mock @actions/core
const mockGetInput = mock(() => '');
const mockDebug = mock(() => {});

mock.module('@actions/core', () => ({
  getInput: mockGetInput,
  debug: mockDebug,
}));

describe('input-utils', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    mockGetInput.mockClear();
    mockDebug.mockClear();
    // Clear environment variables
    delete process.env['INPUT_API_KEY'];
    delete process.env['INPUT_TEST_VALUE'];
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env['INPUT_API_KEY'];
    delete process.env['INPUT_TEST_VALUE'];
  });

  describe('getInputSafe', () => {
    it('should return value from GitHub Actions core when available', () => {
      mockGetInput.mockReturnValue('test-value');

      const result = getInputSafe('api-key', true);

      expect(result).toBe('test-value');
      expect(mockGetInput).toHaveBeenCalledWith('api-key', { required: false });
      expect(mockDebug).toHaveBeenCalledWith("Got input 'api-key' from GitHub Actions core");
    });

    it('should fallback to environment variables when core returns empty', () => {
      mockGetInput.mockReturnValue('');
      process.env['INPUT_API_KEY'] = 'env-value';

      const result = getInputSafe('api-key', true);

      expect(result).toBe('env-value');
      expect(mockDebug).toHaveBeenCalledWith(
        "Got input 'api-key' from environment variable INPUT_API_KEY"
      );
    });

    it('should convert kebab-case to UPPER_SNAKE_CASE for env vars', () => {
      mockGetInput.mockReturnValue('');
      process.env['INPUT_TEST_VALUE'] = 'env-test-value';

      const result = getInputSafe('test-value', true);

      expect(result).toBe('env-test-value');
    });

    it('should throw error when required input is missing', () => {
      mockGetInput.mockReturnValue('');

      expect(() => getInputSafe('missing-input', true)).toThrow(
        'Input required and not supplied: missing-input (INPUT_MISSING_INPUT)'
      );
    });

    it('should return empty string when optional input is missing', () => {
      mockGetInput.mockReturnValue('');

      const result = getInputSafe('optional-input', false);

      expect(result).toBe('');
    });

    it('should handle core.getInput throwing an error', () => {
      mockGetInput.mockImplementation(() => {
        throw new Error('Core not available');
      });
      process.env['INPUT_API_KEY'] = 'fallback-value';

      const result = getInputSafe('api-key', true);

      expect(result).toBe('fallback-value');
      expect(mockDebug).toHaveBeenCalledWith(
        'GitHub Actions core not available, falling back to env vars'
      );
    });
  });

  describe('parseBoolean', () => {
    it('should return true for truthy string values', () => {
      expect(parseBoolean('true')).toBe(true);
      expect(parseBoolean('TRUE')).toBe(true);
      expect(parseBoolean('True')).toBe(true);
      expect(parseBoolean('t')).toBe(true);
      expect(parseBoolean('T')).toBe(true);
      expect(parseBoolean('1')).toBe(true);
      expect(parseBoolean('yes')).toBe(true);
      expect(parseBoolean('YES')).toBe(true);
      expect(parseBoolean(' true ')).toBe(true); // with whitespace
    });

    it('should return false for falsy string values', () => {
      expect(parseBoolean('false')).toBe(false);
      expect(parseBoolean('FALSE')).toBe(false);
      expect(parseBoolean('f')).toBe(false);
      expect(parseBoolean('0')).toBe(false);
      expect(parseBoolean('no')).toBe(false);
      expect(parseBoolean('random')).toBe(false);
      expect(parseBoolean('')).toBe(false);
      expect(parseBoolean('   ')).toBe(false);
    });

    it('should return false for non-string values', () => {
      expect(parseBoolean(undefined)).toBe(false);
      expect(parseBoolean(null as any)).toBe(false);
      expect(parseBoolean(123 as any)).toBe(false);
      expect(parseBoolean(true as any)).toBe(false);
      expect(parseBoolean({} as any)).toBe(false);
    });
  });
});
