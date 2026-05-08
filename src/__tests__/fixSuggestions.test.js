import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Import the module under test.
// These imports will fail until src/fixSuggestions.js is created — that's expected.
// ---------------------------------------------------------------------------
const { generateBrokenLinkSuggestion, generateOutdatedSectionSuggestion } = await import(
  '../../src/fixSuggestions.js'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal BrokenLink with an http_error reason */
function makeBrokenLink(overrides = {}) {
  return {
    url: 'https://example.com/page',
    anchorText: 'Click here',
    reason: { type: 'http_error', statusCode: 404 },
    ...overrides,
  };
}

/** Build a minimal OutdatedSection */
function makeOutdatedSection(overrides = {}) {
  return {
    sectionText: 'This is some section text that describes an outdated feature.',
    reason: 'This API was deprecated in v2.',
    severity: 'medium',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests — generateBrokenLinkSuggestion()
// Validates: Requirements 3.1, 3.3, 3.4
// ---------------------------------------------------------------------------

describe('generateBrokenLinkSuggestion()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('broken link with non-empty anchor text uses anchor text as location', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const link = makeBrokenLink({ anchorText: 'Click here' });
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.location).toBe('Click here');
  });

  test('broken link with empty anchor text uses URL as location', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const link = makeBrokenLink({ anchorText: '', url: 'https://example.com/page' });
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.location).toBe('https://example.com/page');
  });

  test('broken link always has severity: "high"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const link = makeBrokenLink();
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.severity).toBe('high');
  });

  test('broken link has problemType: "broken_link"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const link = makeBrokenLink();
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.problemType).toBe('broken_link');
  });

  test('description contains the reason type and URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const link = makeBrokenLink({ url: 'https://example.com/page', reason: { type: 'http_error', statusCode: 404 } });
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.description).toContain('http_error');
    expect(suggestion.description).toContain('https://example.com/page');
  });

  test('candidateUrl is set when http:// URL has a reachable https:// equivalent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const link = makeBrokenLink({ url: 'http://example.com/page' });
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.candidateUrl).toBe('https://example.com/page');
  });

  test('candidateUrl is omitted when https:// substitution is not reachable (non-2xx)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));
    const link = makeBrokenLink({ url: 'http://example.com/broken' });
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.candidateUrl).toBeUndefined();
  });

  test('candidateUrl is omitted when https:// fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));
    const link = makeBrokenLink({ url: 'http://example.com/broken' });
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.candidateUrl).toBeUndefined();
  });

  test('candidateUrl is omitted when URL already uses https://', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));
    const link = makeBrokenLink({ url: 'https://example.com/page' });
    const suggestion = await generateBrokenLinkSuggestion(link);
    expect(suggestion.candidateUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — generateOutdatedSectionSuggestion()
// Validates: Requirements 3.2, 3.3, 3.4
// ---------------------------------------------------------------------------

describe('generateOutdatedSectionSuggestion()', () => {
  test('outdated section has problemType: "outdated_section"', () => {
    const section = makeOutdatedSection();
    const suggestion = generateOutdatedSectionSuggestion(section);
    expect(suggestion.problemType).toBe('outdated_section');
  });

  test('outdated section severity matches the input section severity', () => {
    for (const severity of ['high', 'medium', 'low']) {
      const section = makeOutdatedSection({ severity });
      const suggestion = generateOutdatedSectionSuggestion(section);
      expect(suggestion.severity).toBe(severity);
    }
  });

  test('outdated section location is the full sectionText when <= 80 chars', () => {
    const sectionText = 'Short text under 80 chars.';
    const section = makeOutdatedSection({ sectionText });
    const suggestion = generateOutdatedSectionSuggestion(section);
    expect(suggestion.location).toBe(sectionText);
    expect(suggestion.location).not.toContain('...');
  });

  test('outdated section location is truncated to 80 chars + "..." when sectionText exceeds 80 chars', () => {
    const sectionText = 'A'.repeat(100);
    const section = makeOutdatedSection({ sectionText });
    const suggestion = generateOutdatedSectionSuggestion(section);
    expect(suggestion.location).toBe('A'.repeat(80) + '...');
  });

  test('outdated section location is exactly 80 chars (no truncation) when sectionText is exactly 80 chars', () => {
    const sectionText = 'B'.repeat(80);
    const section = makeOutdatedSection({ sectionText });
    const suggestion = generateOutdatedSectionSuggestion(section);
    expect(suggestion.location).toBe(sectionText);
    expect(suggestion.location).not.toContain('...');
  });

  test('outdated section description matches the section reason', () => {
    const reason = 'This API was deprecated in v2.';
    const section = makeOutdatedSection({ reason });
    const suggestion = generateOutdatedSectionSuggestion(section);
    expect(suggestion.description).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Property 7: Fix suggestion always contains severity and location
// Feature: course-content-monitor, Property 7: Fix suggestion always contains severity and location
// Validates: Requirements 3.1, 3.2, 3.3, 3.4
// ---------------------------------------------------------------------------

describe('Property 7: Fix suggestion always contains severity and location', () => {
  // Arbitrary for BrokenLinkReason
  const brokenLinkReasonArb = fc.oneof(
    fc.record({ type: fc.constant('http_error'), statusCode: fc.integer({ min: 400, max: 599 }) }),
    fc.constant({ type: 'timeout' }),
    fc.record({ type: fc.constant('redirect_loop'), hopCount: fc.integer({ min: 1, max: 20 }) }),
    fc.record({ type: fc.constant('network_error'), message: fc.string({ minLength: 1 }) }),
  );

  // Arbitrary for BrokenLink
  const brokenLinkArb = fc.record({
    url: fc.webUrl(),
    anchorText: fc.string(),
    reason: brokenLinkReasonArb,
  });

  // Arbitrary for OutdatedSection
  const outdatedSectionArb = fc.record({
    sectionText: fc.string({ minLength: 1 }),
    reason: fc.string({ minLength: 1 }),
    severity: fc.oneof(fc.constant('high'), fc.constant('medium'), fc.constant('low')),
  });

  test('any BrokenLink produces a FixSuggestion with non-null severity and non-empty location', async () => {
    // Stub fetch to avoid real network calls; return non-2xx so candidateUrl is omitted
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));

    await fc.assert(
      fc.asyncProperty(brokenLinkArb, async (brokenLink) => {
        const suggestion = await generateBrokenLinkSuggestion(brokenLink);
        expect(suggestion.severity).toBeTruthy();
        expect(typeof suggestion.location).toBe('string');
        expect(suggestion.location.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );

    vi.restoreAllMocks();
  });

  test('any OutdatedSection produces a FixSuggestion with non-null severity and non-empty location', () => {
    fc.assert(
      fc.property(outdatedSectionArb, (section) => {
        const suggestion = generateOutdatedSectionSuggestion(section);
        expect(suggestion.severity).toBeTruthy();
        expect(typeof suggestion.location).toBe('string');
        expect(suggestion.location.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });
});
