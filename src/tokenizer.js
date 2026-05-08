import { getEncoding } from 'js-tiktoken';

// Initialise once at module level to avoid re-initialising on every call.
// cl100k_base is the encoding used by gpt-4o-mini.
const enc = getEncoding('cl100k_base');

/**
 * Count the number of tokens in a string using the cl100k_base encoder.
 *
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  if (text === '') return 0;
  return enc.encode(text).length;
}
