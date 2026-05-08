import { describe, test, expect } from 'vitest';
import { countTokens } from '../../src/tokenizer.js';

// ---------------------------------------------------------------------------
// Unit tests — countTokens()
// Validates: Requirements 2.1
// ---------------------------------------------------------------------------

describe('countTokens()', () => {
  test('empty string returns 0', () => {
    expect(countTokens('')).toBe(0);
  });

  test('"Hello, world!" returns 4 tokens (cl100k_base encoding)', () => {
    // cl100k_base (used by gpt-4o-mini) encodes "Hello, world!" as:
    // ["Hello", ",", " world", "!"] → 4 tokens
    expect(countTokens('Hello, world!')).toBe(4);
  });

  test('token count is non-decreasing as string length increases (monotonic for typical prose)', () => {
    const short = 'Hello';
    const medium = 'Hello world';
    const long = 'Hello world, this is a longer sentence';

    const countShort = countTokens(short);
    const countMedium = countTokens(medium);
    const countLong = countTokens(long);

    expect(countMedium).toBeGreaterThanOrEqual(countShort);
    expect(countLong).toBeGreaterThanOrEqual(countMedium);
  });
});
