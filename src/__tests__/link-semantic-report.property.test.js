/**
 * Property-based tests for the link-semantic-report feature.
 *
 * Feature: link-semantic-report
 *
 * Properties covered in this file:
 *   Property 1: linkResults completeness and ordering
 *   Property 2: linkResults entry structure invariant
 *   Property 3: semanticCoverage character count accuracy
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5, 2.2, 2.3
 */

// ---------------------------------------------------------------------------
// Chrome API mock — must be set up via vi.stubGlobal before importing modules.
// ---------------------------------------------------------------------------

const mockStorageSet = vi.fn();
const mockStorageGet = vi.fn();
const mockTabsSendMessage = vi.fn();
const mockTabsQuery = vi.fn();
const mockRuntimeOnMessageAddListener = vi.fn();

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: mockStorageGet,
      set: mockStorageSet,
    },
  },
  tabs: {
    sendMessage: mockTabsSendMessage,
    query: mockTabsQuery,
  },
  runtime: {
    onMessage: {
      addListener: mockRuntimeOnMessageAddListener,
    },
  },
});

// ---------------------------------------------------------------------------
// Mock dependency modules before importing background.js.
// vi.mock is hoisted by Vitest, so these run before any imports.
// ---------------------------------------------------------------------------

vi.mock('../../src/linkChecker.js', () => ({
  checkLinks: vi.fn(),
}));

vi.mock('../../src/semanticChecker.js', () => ({
  runSemanticCheck: vi.fn(),
}));

vi.mock('../../src/fixSuggestions.js', () => ({
  generateBrokenLinkSuggestion: vi.fn(),
  generateOutdatedSectionSuggestion: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic imports — after chrome globals and vi.mock are in place.
// ---------------------------------------------------------------------------

const { handleStartCheck, truncateToTokenLimit } = await import('../../background.js');
const { checkLinks } = await import('../../src/linkChecker.js');
const { runSemanticCheck } = await import('../../src/semanticChecker.js');
const { generateBrokenLinkSuggestion, generateOutdatedSectionSuggestion } = await import(
  '../../src/fixSuggestions.js'
);
const { renderReportView } = await import('../../popup/popup.js');

import * as fc from 'fast-check';
import { describe, test, beforeEach, vi, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sender object with a tab id. */
function makeSender(tabId = 1) {
  return { tab: { id: tabId } };
}

/**
 * Build a minimal successful PAGE_DATA response from the content script.
 * @param {{ links?: object[], textContent?: string, pageUrl?: string, pageTitle?: string }} overrides
 */
function makePageDataResponse({ links = [], textContent = '', pageUrl = 'https://example.com/', pageTitle = 'Test Page' } = {}) {
  return {
    type: 'PAGE_DATA',
    payload: { links, textContent, pageUrl, pageTitle },
  };
}

/**
 * Read the last CheckResult written to storage.
 * @returns {import('../../src/types.js').CheckResult}
 */
function getLastStoredResult() {
  const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
  return lastCall[0].checkState.result;
}

// ---------------------------------------------------------------------------
// Default mock setup (re-applied in beforeEach and inside property bodies)
// ---------------------------------------------------------------------------

function setupDefaultMocks() {
  mockStorageSet.mockResolvedValue(undefined);
  mockTabsQuery.mockResolvedValue([{ id: 1 }]);
  runSemanticCheck.mockResolvedValue({ outdatedSections: [] });
  generateBrokenLinkSuggestion.mockResolvedValue({
    problemType: 'broken_link',
    severity: 'high',
    location: 'link',
    description: 'broken',
  });
  generateOutdatedSectionSuggestion.mockReturnValue({
    problemType: 'outdated_section',
    severity: 'medium',
    location: 'section',
    description: 'outdated',
  });
}

/** Sets up the full report-view DOM for rendering property tests. */
function setupReportDOM() {
  document.body.innerHTML = `
    <div id="popup-root">
      <div id="idle-view" class="view" hidden></div>
      <div id="loading-view" class="view" hidden></div>
      <div id="complete-view" class="view" hidden>
        <div id="error-banner" hidden></div>
        <div id="severity-summary">
          <span id="summary-high">0</span>
          <span id="summary-medium">0</span>
          <span id="summary-low">0</span>
        </div>
        <section id="broken-links-section" hidden><ul id="broken-links-list"></ul></section>
        <section id="semantic-issues-section" hidden><ul id="semantic-issues-list"></ul></section>
        <div id="no-problems-message" hidden></div>
      </div>
      <div id="error-view" class="view" hidden></div>
      <div id="report-view" class="view" hidden>
        <div id="report-meta">
          <span id="report-page-url"></span>
          <span id="report-checked-at"></span>
        </div>
        <section id="report-links-section" aria-label="Links checked">
          <p id="report-no-links-msg" hidden></p>
          <ul id="report-links-list" aria-label="Link check results"></ul>
        </section>
        <section id="report-semantic-section" aria-label="Semantic check">
          <div id="report-coverage"></div>
          <p id="report-truncation-notice" hidden></p>
          <p id="report-semantic-error" hidden></p>
          <p id="report-no-outdated-msg" hidden></p>
          <ul id="report-outdated-list" aria-label="Outdated sections"></ul>
        </section>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** A link entry as it appears in the page data (allLinks). */
const linkEntryArb = fc.record({
  url: fc.webUrl(),
  anchorText: fc.string(),
  rawHref: fc.webUrl(),
});

/** Reason arbitraries covering all BrokenLinkReason variants. */
const brokenReasonArb = fc.oneof(
  fc.record({ type: fc.constant('http_error'), statusCode: fc.integer({ min: 400, max: 599 }) }),
  fc.constant({ type: 'timeout' }),
  fc.record({ type: fc.constant('redirect_loop'), hopCount: fc.integer({ min: 6, max: 20 }) }),
  fc.record({ type: fc.constant('network_error'), message: fc.string({ minLength: 1 }) }),
  fc.constant({ type: 'content_404' }),
);

/** A link result entry — union of ok and broken variants. */
const linkResultArb = fc.oneof(
  fc.record({
    status: fc.constant('ok'),
    url: fc.webUrl(),
    anchorText: fc.string(),
  }),
  fc.record({
    status: fc.constant('broken'),
    url: fc.webUrl(),
    anchorText: fc.string(),
    reason: brokenReasonArb,
  }),
);

/** An outdated section arbitrary. */
const outdatedSectionArb = fc.record({
  sectionText: fc.string({ minLength: 1, maxLength: 200 }),
  reason: fc.string({ minLength: 1 }),
  severity: fc.oneof(fc.constant('high'), fc.constant('medium'), fc.constant('low')),
});

// ---------------------------------------------------------------------------
// Property 1: linkResults completeness and ordering
// Feature: link-semantic-report, Property 1: linkResults completeness and ordering
// ---------------------------------------------------------------------------

describe('Property 1: linkResults completeness and ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  /**
   * **Property 1: linkResults completeness and ordering**
   * **Validates: Requirements 1.1, 1.5**
   *
   * For any array of LinkEntry objects, the resulting linkResults array must have
   * the same length as the input, and linkResults[i].url must equal allLinks[i].url
   * for every index i.
   */
  test(
    'for any array of link entries (0–50), linkResults has the same length and preserves url order',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(linkEntryArb, { minLength: 0, maxLength: 50 }),
          async (links) => {
            vi.clearAllMocks();
            setupDefaultMocks();

            // Mock checkLinks to return ok results for all inputs
            checkLinks.mockResolvedValue(
              links.map((entry) => ({ status: 'ok', url: entry.url })),
            );

            mockTabsSendMessage.mockResolvedValue(
              makePageDataResponse({ links }),
            );

            await handleStartCheck(makeSender(1));

            const result = getLastStoredResult();

            // Length must match
            expect(result.linkResults.length).toBe(links.length);

            // URL order must be preserved
            for (let i = 0; i < links.length; i++) {
              expect(result.linkResults[i].url).toBe(links[i].url);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 2: linkResults entry structure invariant
// Feature: link-semantic-report, Property 2: linkResults entry structure invariant
// ---------------------------------------------------------------------------

describe('Property 2: linkResults entry structure invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  /**
   * **Property 2: linkResults entry structure invariant**
   * **Validates: Requirements 1.2, 1.3**
   *
   * For any CheckResult produced by a link check, every entry in linkResults must
   * have a non-empty url string, an anchorText string (possibly empty), and a status
   * of either "ok" or "broken". Every broken entry must have a non-null reason object
   * with a non-empty type field.
   */
  test(
    'for any array of link result entries (0–50), every entry has correct structure and broken entries have reason.type',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(linkResultArb, { minLength: 0, maxLength: 50 }),
          async (generatedResults) => {
            vi.clearAllMocks();
            setupDefaultMocks();

            // Build allLinks from the generated results so the anchorTextMap works
            const allLinks = generatedResults.map((entry) => ({
              url: entry.url,
              anchorText: entry.anchorText,
              rawHref: entry.url,
            }));

            // Map generated results back to LinkCheckResult[] format
            const linkCheckResults = generatedResults.map((entry) => {
              if (entry.status === 'ok') {
                return { status: 'ok', url: entry.url };
              }
              // broken
              return {
                status: 'broken',
                link: {
                  url: entry.url,
                  anchorText: entry.anchorText,
                  reason: entry.reason,
                },
              };
            });

            checkLinks.mockResolvedValue(linkCheckResults);

            mockTabsSendMessage.mockResolvedValue(
              makePageDataResponse({ links: allLinks }),
            );

            await handleStartCheck(makeSender(1));

            const result = getLastStoredResult();

            // Every entry must have the required fields
            for (const entry of result.linkResults) {
              // url must be a non-empty string
              expect(typeof entry.url).toBe('string');
              expect(entry.url.length).toBeGreaterThan(0);

              // anchorText must be a string (possibly empty)
              expect(typeof entry.anchorText).toBe('string');

              // status must be "ok" or "broken"
              expect(['ok', 'broken']).toContain(entry.status);

              // broken entries must have reason.type (non-empty string)
              if (entry.status === 'broken') {
                expect(entry.reason).not.toBeNull();
                expect(typeof entry.reason.type).toBe('string');
                expect(entry.reason.type.length).toBeGreaterThan(0);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 3: semanticCoverage character count accuracy
// Feature: link-semantic-report, Property 3: semanticCoverage character count accuracy
// ---------------------------------------------------------------------------

describe('Property 3: semanticCoverage character count accuracy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
  });

  /**
   * **Property 3: semanticCoverage character count accuracy**
   * **Validates: Requirements 2.2, 2.3**
   *
   * For any text string submitted to the semantic check pipeline:
   * - semanticCoverage.totalCharCount === text.length
   * - semanticCoverage.submittedCharCount === truncateToTokenLimit(text).length
   * - submittedCharCount <= totalCharCount
   */
  test(
    'for any text string (0–100000 chars), semanticCoverage reflects correct char counts',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 100000 }),
          async (text) => {
            vi.clearAllMocks();
            setupDefaultMocks();

            // Compute expected truncated length directly
            const expectedSubmittedLength = truncateToTokenLimit(text).length;

            checkLinks.mockResolvedValue([]);

            mockTabsSendMessage.mockResolvedValue(
              makePageDataResponse({ textContent: text }),
            );

            await handleStartCheck(makeSender(1));

            const result = getLastStoredResult();

            // totalCharCount must equal the original text length
            expect(result.semanticCoverage.totalCharCount).toBe(text.length);

            // submittedCharCount must equal the truncated text length
            expect(result.semanticCoverage.submittedCharCount).toBe(expectedSubmittedLength);

            // submittedCharCount must always be <= totalCharCount
            expect(result.semanticCoverage.submittedCharCount).toBeLessThanOrEqual(
              result.semanticCoverage.totalCharCount,
            );
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 4: Report_View renders all link results
// Feature: link-semantic-report, Property 4: Report_View renders all link results
// ---------------------------------------------------------------------------

describe('Property 4: Report_View renders all link results', () => {
  beforeEach(() => {
    setupReportDOM();
  });

  /**
   * **Property 4: Report_View renders all link results**
   * **Validates: Requirements 4.1, 4.2**
   *
   * For any non-empty linkResults array, the rendered Report_View must contain
   * exactly linkResults.length list items in #report-links-list. Each item must
   * display the anchor text (or the URL if anchor text is empty) and the URL.
   */
  test(
    'for any non-empty linkResults array (1–30), #report-links-list has the same count and each item shows anchor text (or URL) and URL',
    () => {
      fc.assert(
        fc.property(
          fc.array(linkResultArb, { minLength: 1, maxLength: 30 }),
          (generatedResults) => {
            setupReportDOM();

            renderReportView({
              pageUrl: 'https://example.com',
              pageTitle: 'Test',
              brokenLinks: [],
              outdatedSections: [],
              fixSuggestions: [],
              checkedAt: new Date().toISOString(),
              linkResults: generatedResults,
              semanticCoverage: null,
            });

            const linksList = document.getElementById('report-links-list');
            const items = linksList.querySelectorAll('li');

            // Count must match
            expect(items.length).toBe(generatedResults.length);

            // Each item must contain the anchor text (or URL) and the URL
            for (let i = 0; i < generatedResults.length; i++) {
              const item = items[i];
              const entry = generatedResults[i];
              const displayText = entry.anchorText || entry.url;
              expect(item.textContent).toContain(displayText);
              expect(item.textContent).toContain(entry.url);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 5: Report_View broken link display invariant
// Feature: link-semantic-report, Property 5: Report_View broken link display invariant
// ---------------------------------------------------------------------------

describe('Property 5: Report_View broken link display invariant', () => {
  beforeEach(() => {
    setupReportDOM();
  });

  /**
   * **Property 5: Report_View broken link display invariant**
   * **Validates: Requirements 4.4, 4.5, 7.3**
   *
   * For any linkResults array, every entry with status === "broken" must be rendered
   * with: (a) the reason.type string visible in the item, (b) the HTTP status code
   * visible when reason.type === "http_error", and (c) an aria-label communicating
   * the broken status to screen readers.
   */
  test(
    'for any linkResults array (0–20), every broken item shows reason.type, statusCode for http_error, and has a Broken aria-label',
    () => {
      fc.assert(
        fc.property(
          fc.array(linkResultArb, { minLength: 0, maxLength: 20 }),
          (generatedResults) => {
            setupReportDOM();

            renderReportView({
              pageUrl: 'https://example.com',
              pageTitle: 'Test',
              brokenLinks: [],
              outdatedSections: [],
              fixSuggestions: [],
              checkedAt: new Date().toISOString(),
              linkResults: generatedResults,
              semanticCoverage: null,
            });

            const linksList = document.getElementById('report-links-list');
            const items = linksList.querySelectorAll('li');

            for (let i = 0; i < generatedResults.length; i++) {
              const entry = generatedResults[i];
              if (entry.status !== 'broken') continue;

              const item = items[i];

              // (a) reason.type must be visible in the item text
              expect(item.textContent).toContain(entry.reason.type);

              // (b) statusCode must be visible for http_error
              if (entry.reason.type === 'http_error') {
                expect(item.textContent).toContain(String(entry.reason.statusCode));
              }

              // (c) an element with aria-label containing "Broken" must exist
              const badgeWithAriaLabel = item.querySelector('[aria-label]');
              expect(badgeWithAriaLabel).not.toBeNull();
              expect(badgeWithAriaLabel.getAttribute('aria-label')).toContain('Broken');
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 6: Report_View semantic coverage display
// Feature: link-semantic-report, Property 6: Report_View semantic coverage display
// ---------------------------------------------------------------------------

describe('Property 6: Report_View semantic coverage display', () => {
  beforeEach(() => {
    setupReportDOM();
  });

  /**
   * **Property 6: Report_View semantic coverage display**
   * **Validates: Requirements 5.2, 5.3**
   *
   * For any non-null semanticCoverage object, the rendered "Semantic Check" section
   * must display both submittedCharCount and totalCharCount. When
   * submittedCharCount < totalCharCount, a truncation notice must also be visible.
   */
  test(
    'for any semanticCoverage (submitted <= total), #report-coverage is non-empty and truncation notice is shown iff submitted < total',
    () => {
      fc.assert(
        fc.property(
          fc.nat().chain((total) =>
            fc.nat({ max: total }).map((submitted) => ({
              submittedCharCount: submitted,
              totalCharCount: total,
            })),
          ),
          (semanticCoverage) => {
            setupReportDOM();

            renderReportView({
              pageUrl: 'https://example.com',
              pageTitle: 'Test',
              brokenLinks: [],
              outdatedSections: [],
              fixSuggestions: [],
              checkedAt: new Date().toISOString(),
              linkResults: null,
              semanticCoverage,
            });

            const coverageEl = document.getElementById('report-coverage');
            const truncationNotice = document.getElementById('report-truncation-notice');

            // Both counts must be displayed (non-empty coverage text)
            expect(coverageEl.textContent.length).toBeGreaterThan(0);

            // Truncation notice is hidden iff submittedCharCount >= totalCharCount
            if (semanticCoverage.submittedCharCount < semanticCoverage.totalCharCount) {
              expect(truncationNotice.hidden).toBe(false);
            } else {
              expect(truncationNotice.hidden).toBe(true);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 7: Report_View outdated sections display
// Feature: link-semantic-report, Property 7: Report_View outdated sections display
// ---------------------------------------------------------------------------

describe('Property 7: Report_View outdated sections display', () => {
  beforeEach(() => {
    setupReportDOM();
  });

  /**
   * **Property 7: Report_View outdated sections display**
   * **Validates: Requirements 5.4**
   *
   * For any non-empty outdatedSections array, the rendered #report-outdated-list
   * must contain exactly outdatedSections.length list items. Each item must display
   * the sectionText truncated to at most 120 characters, the reason, and the severity.
   */
  test(
    'for any non-empty outdatedSections array (1–20), #report-outdated-list has the same count and each item shows truncated sectionText, reason, and severity',
    () => {
      fc.assert(
        fc.property(
          fc.array(outdatedSectionArb, { minLength: 1, maxLength: 20 }),
          (outdatedSections) => {
            setupReportDOM();

            renderReportView({
              pageUrl: 'https://example.com',
              pageTitle: 'Test',
              brokenLinks: [],
              outdatedSections,
              fixSuggestions: [],
              checkedAt: new Date().toISOString(),
              linkResults: null,
              semanticCoverage: { submittedCharCount: 1000, totalCharCount: 1000 },
            });

            const outdatedList = document.getElementById('report-outdated-list');
            const items = outdatedList.querySelectorAll('li');

            // Count must match
            expect(items.length).toBe(outdatedSections.length);

            for (let i = 0; i < outdatedSections.length; i++) {
              const item = items[i];
              const section = outdatedSections[i];

              // sectionText truncated to ≤ 120 chars must appear
              const truncated =
                section.sectionText.length > 120
                  ? section.sectionText.slice(0, 120)
                  : section.sectionText;
              expect(item.textContent).toContain(truncated);

              // reason must appear
              expect(item.textContent).toContain(section.reason);

              // severity must appear (capitalised badge)
              const capitalised =
                section.severity.charAt(0).toUpperCase() + section.severity.slice(1);
              expect(item.textContent).toContain(capitalised);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 8: Report_View metadata display
// Feature: link-semantic-report, Property 8: Report_View metadata display
// ---------------------------------------------------------------------------

describe('Property 8: Report_View metadata display', () => {
  beforeEach(() => {
    setupReportDOM();
  });

  /**
   * **Property 8: Report_View metadata display**
   * **Validates: Requirements 6.3, 6.4**
   *
   * For any CheckResult, the rendered Report_View must display the pageUrl and a
   * human-readable local date/time string derived from checkedAt. The formatted
   * timestamp must be a non-empty string and must differ from the raw ISO 8601 value.
   */
  test(
    'for any pageUrl and checkedAt ISO string, #report-page-url shows pageUrl and #report-checked-at shows a non-empty formatted timestamp different from the raw ISO string',
    () => {
      fc.assert(
        fc.property(
          fc.record({
            pageUrl: fc.webUrl(),
            checkedAt: fc.date().map((d) => d.toISOString()),
          }),
          ({ pageUrl, checkedAt }) => {
            setupReportDOM();

            renderReportView({
              pageUrl,
              pageTitle: 'Test',
              brokenLinks: [],
              outdatedSections: [],
              fixSuggestions: [],
              checkedAt,
              linkResults: null,
              semanticCoverage: null,
            });

            const pageUrlEl = document.getElementById('report-page-url');
            const checkedAtEl = document.getElementById('report-checked-at');

            // pageUrl must be displayed exactly
            expect(pageUrlEl.textContent).toBe(pageUrl);

            // formatted timestamp must be non-empty
            expect(checkedAtEl.textContent.length).toBeGreaterThan(0);

            // formatted timestamp must differ from the raw ISO string
            expect(checkedAtEl.textContent).not.toBe(checkedAt);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
