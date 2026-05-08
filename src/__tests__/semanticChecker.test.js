import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// We need to mock chrome.storage.local before importing the module under test.
// ---------------------------------------------------------------------------
const mockStorageGet = vi.fn();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: mockStorageGet,
    },
  },
});

const { buildSemanticPrompt, parseLLMResponse, runSemanticCheck } = await import(
  '../../src/semanticChecker.js'
);

// ---------------------------------------------------------------------------
// Property 5: Semantic prompt always contains required instructions
// Feature: course-content-monitor, Property 5: Semantic prompt always contains required instructions
// Validates: Requirements 2.2
// ---------------------------------------------------------------------------
describe('buildSemanticPrompt() — Property 5', () => {
  test('always contains required instruction keywords for any page content', () => {
    fc.assert(
      fc.property(fc.string(), (content) => {
        const prompt = buildSemanticPrompt(content);
        expect(prompt).toContain('deprecated');
        expect(prompt).toContain('outdated');
        expect(prompt).toContain('API');
        expect(prompt).toContain('UI');
        expect(prompt).toContain('severity');
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — parseLLMResponse()
// Validates: Requirements 2.3, 2.4, 2.5, 2.6
// ---------------------------------------------------------------------------
describe('parseLLMResponse()', () => {
  const textContent = 'The old API endpoint /v1/users is deprecated. Use /v2/users instead.';

  test('entry with sectionText not in textContent is discarded and console.warn is called', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llmResponse = {
      flaggedSections: [
        { sectionText: 'this text does not appear on the page at all', reason: 'outdated', severity: 'high' },
      ],
    };
    const result = parseLLMResponse(llmResponse, textContent);
    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('entry with invalid severity is discarded', () => {
    const llmResponse = {
      flaggedSections: [
        { sectionText: 'old API endpoint /v1/users', reason: 'outdated', severity: 'critical' },
      ],
    };
    const result = parseLLMResponse(llmResponse, textContent);
    expect(result).toHaveLength(0);
  });

  test('entry with missing reason is discarded', () => {
    const llmResponse = {
      flaggedSections: [
        { sectionText: 'old API endpoint /v1/users', severity: 'high' },
      ],
    };
    const result = parseLLMResponse(llmResponse, textContent);
    expect(result).toHaveLength(0);
  });

  test('empty flaggedSections array returns []', () => {
    const result = parseLLMResponse({ flaggedSections: [] }, textContent);
    expect(result).toEqual([]);
  });

  test('malformed JSON (non-array flaggedSections) is handled gracefully', () => {
    const result = parseLLMResponse({ flaggedSections: 'not an array' }, textContent);
    expect(result).toEqual([]);
  });

  test('all valid entries are returned with correct severity mapping', () => {
    const llmResponse = {
      flaggedSections: [
        { sectionText: 'old API endpoint /v1/users is deprecated', reason: 'API renamed', severity: 'high' },
        { sectionText: 'Use /v2/users instead', reason: 'stale reference', severity: 'medium' },
        { sectionText: 'The old API endpoint', reason: 'minor note', severity: 'low' },
      ],
    };
    const result = parseLLMResponse(llmResponse, textContent);
    expect(result).toHaveLength(3);
    expect(result[0].severity).toBe('high');
    expect(result[1].severity).toBe('medium');
    expect(result[2].severity).toBe('low');
    expect(result[0].sectionText).toBe('old API endpoint /v1/users is deprecated');
    expect(result[0].reason).toBe('API renamed');
  });
});

// ---------------------------------------------------------------------------
// Property 6: LLM response parsing completeness and severity mapping
// Feature: course-content-monitor, Property 6: LLM response parsing completeness and severity mapping
// Validates: Requirements 2.3, 2.4, 2.5, 2.6
// ---------------------------------------------------------------------------
describe('parseLLMResponse() — Property 6', () => {
  test('returns exactly one OutdatedSection per valid entry; discards entries not in textContent', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 20 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (textContent, validCount, invalidCount) => {
          const validSeverities = ['high', 'medium', 'low'];

          // Build valid entries by slicing substrings of textContent
          const validEntries = Array.from({ length: validCount }, (_, i) => {
            const start = i % textContent.length;
            const end = Math.min(start + 3, textContent.length);
            const slice = textContent.slice(start, end);
            // Only use non-empty slices
            if (!slice) return null;
            return {
              sectionText: slice,
              reason: 'some reason',
              severity: validSeverities[i % 3],
            };
          }).filter(Boolean);

          // Build invalid entries: strings guaranteed not in textContent
          const invalidEntries = Array.from({ length: invalidCount }, (_, i) => ({
            sectionText: `\x00INVALID_ENTRY_${i}_\x00`,
            reason: 'some reason',
            severity: validSeverities[i % 3],
          }));

          const llmResponse = { flaggedSections: [...validEntries, ...invalidEntries] };
          const result = parseLLMResponse(llmResponse, textContent);

          // All results must have sectionText present in textContent
          for (const entry of result) {
            expect(textContent).toContain(entry.sectionText);
          }

          // Count how many valid entries actually appear in textContent
          const trueValidCount = validEntries.filter(
            (e) => e && textContent.includes(e.sectionText),
          ).length;

          expect(result).toHaveLength(trueValidCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — runSemanticCheck()
// Validates: Requirements 2.3, 2.7
// ---------------------------------------------------------------------------
describe('runSemanticCheck()', () => {
  const textContent = 'The old API endpoint /v1/users is deprecated. Use /v2/users instead.';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    // Re-stub chrome after unstubbing
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: mockStorageGet,
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('missing API key returns error result without throwing', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: undefined });
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('No API key');
  });

  test('LLM API non-200 response returns outdatedSections: [] with semanticCheckError set', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'Service Unavailable' }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toBeTruthy();
  });

  test('LLM API timeout returns outdatedSections: [] with timeout semanticCheckError', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('timed out');
  });

  test('response wrapped in markdown code fences is parsed correctly', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    const jsonPayload = JSON.stringify({
      flaggedSections: [
        { sectionText: 'old API endpoint /v1/users is deprecated', reason: 'API renamed', severity: 'high' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n' + jsonPayload + '\n```' } }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toHaveLength(1);
    expect(result.outdatedSections[0].severity).toBe('high');
    expect(result.semanticCheckError).toBeUndefined();
  });

  test('response wrapped in plain code fences (no language tag) is parsed correctly', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    const jsonPayload = JSON.stringify({
      flaggedSections: [
        { sectionText: 'Use /v2/users instead', reason: 'stale reference', severity: 'medium' },
      ],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```\n' + jsonPayload + '\n```' } }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toHaveLength(1);
    expect(result.outdatedSections[0].severity).toBe('medium');
    expect(result.semanticCheckError).toBeUndefined();
  });

  test('invalid JSON response returns outdatedSections: [] with unexpected-response semanticCheckError', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('unexpected response');
  });

  test('all-malformed entries (non-empty flaggedSections, all discarded) sets semanticCheckError', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              flaggedSections: [
                { sectionText: '\x00NOT_ON_PAGE\x00', reason: 'r', severity: 'high' },
              ],
            }),
          },
        }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toBeUndefined();
  });

  test('duplicate sectionText entries are deduplicated (first occurrence kept)', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              flaggedSections: [
                { sectionText: 'old API endpoint /v1/users is deprecated', reason: 'first', severity: 'high' },
                { sectionText: 'old API endpoint /v1/users is deprecated', reason: 'duplicate', severity: 'medium' },
              ],
            }),
          },
        }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toHaveLength(1);
    expect(result.outdatedSections[0].reason).toBe('first');
    expect(result.semanticCheckError).toBeUndefined();
  });

  test('response with null content but valid reasoning field is parsed correctly', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            reasoning: JSON.stringify({
              flaggedSections: [
                { sectionText: 'old API endpoint /v1/users is deprecated', reason: 'API renamed', severity: 'high' },
              ],
            }),
          },
        }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toHaveLength(1);
    expect(result.outdatedSections[0].severity).toBe('high');
    expect(result.semanticCheckError).toBeUndefined();
  });

  test('response with null content but valid reasoning_content field is parsed correctly', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            reasoning_content: JSON.stringify({
              flaggedSections: [
                { sectionText: 'Use /v2/users instead', reason: 'stale reference', severity: 'medium' },
              ],
            }),
          },
        }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toHaveLength(1);
    expect(result.outdatedSections[0].severity).toBe('medium');
    expect(result.semanticCheckError).toBeUndefined();
  });

  test('response with null content and null reasoning returns unexpected-response error', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: null, reasoning: null } }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('unexpected response');
  });

  test('successful response returns parsed OutdatedSection[] with no semanticCheckError', async () => {
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              flaggedSections: [
                { sectionText: 'old API endpoint /v1/users is deprecated', reason: 'API renamed', severity: 'high' },
              ],
            }),
          },
        }],
      }),
    }));
    const result = await runSemanticCheck(textContent, {});
    expect(result.outdatedSections).toHaveLength(1);
    expect(result.outdatedSections[0].severity).toBe('high');
    expect(result.semanticCheckError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 1: Bug Condition — All-Discarded Returns No Error
// Validates: Requirements 1.1, 1.2
//
// CRITICAL: These tests MUST FAIL on unfixed code — failure confirms the bug exists.
// The all-discarded guard currently sets semanticCheckError to
// "Semantic check results could not be parsed. Link results are shown below."
// when all flaggedSections entries are discarded, which is incorrect behavior.
// ---------------------------------------------------------------------------
describe('runSemanticCheck() — Property 1: Bug Condition — All-Discarded Returns No Error', () => {
  const textContent = 'The old API endpoint /v1/users is deprecated. Use /v2/users instead.';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: mockStorageGet,
        },
      },
    });
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test case 1: single entry whose sectionText is not present in textContent
  // (hallucination guard discards it)
  test('single hallucinated entry (sectionText not in textContent) returns no error and empty outdatedSections', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              flaggedSections: [
                {
                  sectionText: 'This text does not appear anywhere on the page',
                  reason: 'hallucinated content',
                  severity: 'high',
                },
              ],
            }),
          },
        }],
      }),
    }));

    const result = await runSemanticCheck(textContent, {});

    // Expected behavior: clean run with zero findings, no error
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toBeUndefined();
  });

  // Test case 2: single entry with severity: "critical" (invalid field, discarded by field validation)
  test('single entry with invalid severity field (critical) returns no error and empty outdatedSections', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              flaggedSections: [
                {
                  sectionText: 'old API endpoint /v1/users is deprecated',
                  reason: 'API renamed',
                  severity: 'critical', // invalid — only high/medium/low are valid
                },
              ],
            }),
          },
        }],
      }),
    }));

    const result = await runSemanticCheck(textContent, {});

    // Expected behavior: clean run with zero findings, no error
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toBeUndefined();
  });

  // Test case 3: three entries all with sectionText not present in textContent
  test('three hallucinated entries (all sectionTexts not in textContent) returns no error and empty outdatedSections', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              flaggedSections: [
                {
                  sectionText: 'This phrase is not on the page at all',
                  reason: 'hallucinated',
                  severity: 'high',
                },
                {
                  sectionText: 'Another fabricated excerpt from nowhere',
                  reason: 'hallucinated',
                  severity: 'medium',
                },
                {
                  sectionText: 'Yet another invented section text',
                  reason: 'hallucinated',
                  severity: 'low',
                },
              ],
            }),
          },
        }],
      }),
    }));

    const result = await runSemanticCheck(textContent, {});

    // Expected behavior: clean run with zero findings, no error
    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 2: Preservation — Genuine Error Paths Unchanged
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
//
// These tests MUST PASS on UNFIXED code — they capture baseline behavior for
// all non-bug-condition inputs and must remain passing after the fix is applied.
// ---------------------------------------------------------------------------
describe('runSemanticCheck() — Property 2: Preservation — Genuine Error Paths Unchanged', () => {
  const textContent = 'The old API endpoint /v1/users is deprecated. Use /v2/users instead.';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: mockStorageGet,
        },
      },
    });
    mockStorageGet.mockResolvedValue({ openrouterApiKey: 'sk-test' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Property test A: JSON parse failure — fetch returns 200 but json() throws SyntaxError
  // Validates: Requirement 3.1
  test('Property A — JSON parse failure: semanticCheckError contains "unexpected response" and outdatedSections is []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    }));

    const result = await runSemanticCheck(textContent, {});

    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('unexpected response');
  });

  // Property test B: HTTP error — fetch returns { ok: false, status: 503 }
  // Validates: Requirement 3.3
  test('Property B — HTTP 503 error: semanticCheckError contains "503" and outdatedSections is []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));

    const result = await runSemanticCheck(textContent, {});

    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('503');
  });

  // Property test C: timeout — fetch rejects with AbortError
  // Validates: Requirement 3.2
  test('Property C — timeout (AbortError): semanticCheckError contains "timed out" and outdatedSections is []', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    ));

    const result = await runSemanticCheck(textContent, {});

    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('timed out');
  });

  // Property test D: missing API key — chrome.storage.local.get returns {}
  // Validates: Requirement 3.6
  test('Property D — missing API key: semanticCheckError contains "No API key" and outdatedSections is []', async () => {
    mockStorageGet.mockResolvedValue({});

    const result = await runSemanticCheck(textContent, {});

    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toContain('No API key');
  });

  // Property test E: valid entries preserved — one entry whose sectionText is in textContent
  // Validates: Requirement 3.4
  test('Property E — valid entry preserved: outdatedSections has length 1 and semanticCheckError is undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              flaggedSections: [
                {
                  sectionText: 'old API endpoint /v1/users is deprecated',
                  reason: 'API renamed',
                  severity: 'high',
                },
              ],
            }),
          },
        }],
      }),
    }));

    const result = await runSemanticCheck(textContent, {});

    expect(result.outdatedSections).toHaveLength(1);
    expect(result.semanticCheckError).toBeUndefined();
  });

  // Property test F: empty flaggedSections preserved — LLM returns { flaggedSections: [] }
  // Validates: Requirement 3.5
  test('Property F — empty flaggedSections: outdatedSections is [] and semanticCheckError is undefined', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({ flaggedSections: [] }),
          },
        }],
      }),
    }));

    const result = await runSemanticCheck(textContent, {});

    expect(result.outdatedSections).toEqual([]);
    expect(result.semanticCheckError).toBeUndefined();
  });

  // Property-based test G: random non-empty flaggedSections where at least one entry has
  // a valid sectionText present in textContent — these are non-bug-condition inputs.
  // Validates: Requirement 3.4
  test('Property G — random valid entries: outdatedSections is non-empty and semanticCheckError is undefined', async () => {
    // Substrings of textContent guaranteed to be present in the page
    const validSubstrings = [
      'old API endpoint',
      '/v1/users is deprecated',
      'Use /v2/users instead',
      'The old API',
      '/v2/users',
    ];

    await fc.assert(
      fc.asyncProperty(
        // Pick 1–3 valid entries (sectionText is a substring of textContent)
        fc.array(
          fc.record({
            sectionText: fc.constantFrom(...validSubstrings),
            reason: fc.string({ minLength: 1, maxLength: 50 }),
            severity: fc.constantFrom('high', 'medium', 'low'),
          }),
          { minLength: 1, maxLength: 3 },
        ),
        async (validEntries) => {
          vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({ flaggedSections: validEntries }),
                },
              }],
            }),
          }));

          const result = await runSemanticCheck(textContent, {});

          expect(result.outdatedSections.length).toBeGreaterThan(0);
          expect(result.semanticCheckError).toBeUndefined();
        },
      ),
      { numRuns: 50 },
    );
  });
});
