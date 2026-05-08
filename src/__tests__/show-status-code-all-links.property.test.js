/**
 * Property-based tests for the show-status-code-all-links feature.
 *
 * Feature: show-status-code-all-links
 *
 * Properties covered in this file:
 *   Property 1: OK link checker result carries the response status code
 *   Property 2: Background worker copies statusCode into every LinkResultOk
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Chrome API mock — must be set up before importing background.js
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
// Mock background.js dependencies so we can import it cleanly
// ---------------------------------------------------------------------------

vi.mock('../../src/linkChecker.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkLinks: vi.fn(),
  };
});

vi.mock('../../src/semanticChecker.js', () => ({
  runSemanticCheck: vi.fn(),
}));

vi.mock('../../src/fixSuggestions.js', () => ({
  generateBrokenLinkSuggestion: vi.fn(),
  generateOutdatedSectionSuggestion: vi.fn(),
}));

vi.mock('../../src/tokenizer.js', () => ({
  countTokens: vi.fn().mockReturnValue(0),
}));

// ---------------------------------------------------------------------------
// Dynamic imports — after mocks are in place
// ---------------------------------------------------------------------------

const { handleStartCheck, handleStartLinkCheck } = await import('../../background.js');
const { checkLinks } = await import('../../src/linkChecker.js');
const { runSemanticCheck } = await import('../../src/semanticChecker.js');
const { generateBrokenLinkSuggestion } = await import('../../src/fixSuggestions.js');

// Import checkSingleLink directly for Property 1
const { checkSingleLink } = await import('../../src/linkChecker.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal successful PAGE_DATA response from the content script. */
function makePageDataResponse(links = []) {
  return {
    type: 'PAGE_DATA',
    payload: {
      links,
      textContent: 'Some page text content.',
      pageUrl: 'https://example.com/course',
      pageTitle: 'Example Course',
    },
  };
}

/** Build a sender object with a tab id. */
function makeSender(tabId = 1) {
  return { tab: { id: tabId } };
}

// ---------------------------------------------------------------------------
// Property 1: OK link checker result carries the response status code
// Feature: show-status-code-all-links, Property 1: OK link checker result carries the response status code
// Validates: Requirements 1.1, 1.2, 1.3, 1.4
// ---------------------------------------------------------------------------

describe('Property 1: OK link checker result carries the response status code', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
   *
   * For any 2xx status code, checkSingleLink must return { status: 'ok', statusCode }
   * where statusCode equals the mocked response status.
   */
  test(
    'Feature: show-status-code-all-links, Property 1: OK link checker result carries the response status code — ' +
      'for any 2xx HEAD response, result.status === "ok" and result.statusCode equals the mocked status',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 200, max: 299 }),
          async (mockedResponseStatus) => {
            vi.stubGlobal('fetch', vi.fn(() =>
              Promise.resolve({
                status: mockedResponseStatus,
                headers: { get: () => null },
              })
            ));

            const link = { url: 'https://example.com/page', anchorText: 'Test Link', rawHref: '/page' };
            const result = await checkSingleLink(link, { timeoutMs: 5000, maxRedirects: 5, concurrency: 10, perDomainConcurrency: 2 });

            expect(result.status).toBe('ok');
            expect(result.statusCode).toBe(mockedResponseStatus);

            vi.restoreAllMocks();
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  /**
   * **Validates: Requirements 1.3**
   *
   * When HEAD returns 403 and GET also returns 403 (bot-blocked),
   * checkSingleLink must return { status: 'ok', statusCode: 403 }.
   */
  test(
    'Feature: show-status-code-all-links, Property 1: OK link checker result carries the response status code — ' +
      '403 HEAD → 403 GET (bot-blocked) returns status "ok" with statusCode 403',
    async () => {
      const mockFetch = vi.fn();
      // HEAD → 403
      mockFetch.mockResolvedValueOnce({
        status: 403,
        headers: { get: () => null },
      });
      // GET → 403 (bot-blocked)
      mockFetch.mockResolvedValueOnce({
        status: 403,
        headers: { get: () => null },
        body: { cancel: vi.fn() },
      });
      vi.stubGlobal('fetch', mockFetch);

      const link = { url: 'https://www.follower24.de/', anchorText: 'Bot-blocked', rawHref: '/' };
      const result = await checkSingleLink(link, { timeoutMs: 5000, maxRedirects: 5, concurrency: 10, perDomainConcurrency: 2 });

      expect(result.status).toBe('ok');
      expect(result.statusCode).toBe(403);
    }
  );

  /**
   * **Validates: Requirements 1.3**
   *
   * When HEAD returns 429 and GET also returns 429 (rate-limited),
   * checkSingleLink must return { status: 'ok', statusCode: 429 }.
   */
  test(
    'Feature: show-status-code-all-links, Property 1: OK link checker result carries the response status code — ' +
      '429 HEAD → 429 GET (rate-limited) returns status "ok" with statusCode 429',
    async () => {
      const mockFetch = vi.fn();
      // HEAD → 429
      mockFetch.mockResolvedValueOnce({
        status: 429,
        headers: { get: () => null },
      });
      // GET → 429 (rate-limited)
      mockFetch.mockResolvedValueOnce({
        status: 429,
        headers: { get: () => null },
        body: { cancel: vi.fn() },
      });
      vi.stubGlobal('fetch', mockFetch);

      const link = { url: 'https://github.com/vitejs/vite', anchorText: 'Rate-limited', rawHref: '/' };
      const result = await checkSingleLink(link, { timeoutMs: 5000, maxRedirects: 5, concurrency: 10, perDomainConcurrency: 2 });

      expect(result.status).toBe('ok');
      expect(result.statusCode).toBe(429);
    }
  );
});

// ---------------------------------------------------------------------------
// Property 2: Background worker copies statusCode into every LinkResultOk
// Feature: show-status-code-all-links, Property 2: Background worker copies statusCode into every LinkResultOk
// Validates: Requirements 2.1, 2.2
// ---------------------------------------------------------------------------

describe('Property 2: Background worker copies statusCode into every LinkResultOk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSet.mockResolvedValue(undefined);
    mockTabsQuery.mockResolvedValue([{ id: 1 }]);
    // runSemanticCheck is mocked — return empty result for handleStartCheck
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });
    generateBrokenLinkSuggestion.mockResolvedValue({
      problemType: 'broken_link',
      severity: 'high',
      location: 'some link',
      description: 'broken',
    });
  });

  /**
   * **Validates: Requirements 2.1, 2.2**
   *
   * For any array of link entries with generated statusCodes, after handleStartLinkCheck
   * completes, every LinkResultOk in stored linkResults must have statusCode equal to
   * the generated value. No entry may have undefined or NaN as statusCode.
   */
  test(
    'Feature: show-status-code-all-links, Property 2: Background worker copies statusCode into every LinkResultOk — ' +
      'for any array of ok link entries with statusCodes, every stored LinkResultOk has the correct statusCode (no undefined, no NaN)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              url: fc.webUrl(),
              anchorText: fc.string(),
              statusCode: fc.integer({ min: 200, max: 299 }),
            }),
            { minLength: 0, maxLength: 30 }
          ),
          async (linkEntries) => {
            vi.clearAllMocks();
            mockStorageSet.mockResolvedValue(undefined);
            mockTabsQuery.mockResolvedValue([{ id: 1 }]);

            // Build the links array for the page data payload
            const links = linkEntries.map(({ url, anchorText }) => ({
              url,
              anchorText,
              rawHref: url,
            }));

            // Mock the content script response
            mockTabsSendMessage.mockResolvedValue(makePageDataResponse(links));

            // Mock checkLinks to return ok results with the generated statusCodes
            checkLinks.mockResolvedValue(
              linkEntries.map(({ url, statusCode }) => ({
                status: 'ok',
                url,
                statusCode,
              }))
            );

            await handleStartLinkCheck(makeSender(1));

            const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
            const { result } = lastCall[0].checkState;

            expect(result.linkResults).toHaveLength(linkEntries.length);

            for (let i = 0; i < linkEntries.length; i++) {
              const stored = result.linkResults[i];
              const expected = linkEntries[i];

              // Must be an ok entry
              expect(stored.status).toBe('ok');

              // statusCode must equal the generated value — not undefined, not NaN
              expect(stored.statusCode).toBe(expected.statusCode);
              expect(stored.statusCode).not.toBeUndefined();
              expect(Number.isNaN(stored.statusCode)).toBe(false);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Report_View DOM setup helper (mirrors report-view.rendering.test.js)
// ---------------------------------------------------------------------------

/**
 * Sets up the full popup DOM structure including the report-view.
 * Mirrors the structure in popup/popup.html.
 */
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
        <section id="broken-links-section" hidden>
          <ul id="broken-links-list"></ul>
        </section>
        <section id="semantic-issues-section" hidden>
          <ul id="semantic-issues-list"></ul>
        </section>
        <div id="no-problems-message" hidden></div>
        <div class="action-area action-area--footer">
          <button id="view-report-btn" aria-label="View full check report">View Report</button>
        </div>
      </div>
      <div id="error-view" class="view" hidden></div>
      <div id="report-view" class="view" hidden>
        <header>
          <button id="back-btn" aria-label="Back to results">← Back</button>
          <h1>Check Report</h1>
        </header>
        <div id="report-meta">
          <span id="report-page-url"></span>
          <span id="report-checked-at"></span>
        </div>
        <section id="report-links-section" aria-label="Links checked">
          <h2>Links Checked</h2>
          <p id="report-no-links-msg" hidden>No links were found on this page.</p>
          <ul id="report-links-list" aria-label="Link check results"></ul>
        </section>
        <section id="report-semantic-section" aria-label="Semantic check">
          <h2>Semantic Check</h2>
          <div id="report-coverage"></div>
          <p id="report-truncation-notice" hidden></p>
          <p id="report-semantic-error" hidden></p>
          <p id="report-no-outdated-msg" hidden>No outdated sections were found.</p>
          <ul id="report-outdated-list" aria-label="Outdated sections"></ul>
        </section>
      </div>
    </div>
    <div id="settings-panel">
      <input id="api-key-input" type="password" />
      <button id="save-api-key-btn">Save</button>
    </div>
  `;
}

/**
 * Builds a minimal CheckResult for use in report-view tests.
 * @param {object} overrides
 * @returns {object}
 */
function makeCheckResult(overrides = {}) {
  return {
    pageUrl: 'https://example.com/course',
    pageTitle: 'Example Course',
    brokenLinks: [],
    outdatedSections: [],
    fixSuggestions: [],
    checkedAt: new Date().toISOString(),
    linkResults: null,
    semanticCoverage: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import renderReportView for Properties 3 & 4
// ---------------------------------------------------------------------------

const { renderReportView } = await import('../../popup/popup.js');

// ---------------------------------------------------------------------------
// Property 3: Report_View displays statusCode for every OK link that has one
// Feature: show-status-code-all-links, Property 3: Report_View displays statusCode for every OK link that has one
// Validates: Requirements 3.1, 3.4
// ---------------------------------------------------------------------------

describe('Property 3: Report_View displays statusCode for every OK link that has one', () => {
  beforeEach(() => {
    setupReportDOM();
  });

  /**
   * **Validates: Requirements 3.1, 3.4**
   *
   * For any array of ok link results with a numeric statusCode, after renderReportView
   * is called, each rendered <li> in #report-links-list must contain the string
   * representation of that statusCode.
   */
  test(
    'Feature: show-status-code-all-links, Property 3: Report_View displays statusCode for every OK link that has one — ' +
      'each rendered <li> contains the string representation of statusCode',
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              status: fc.constant('ok'),
              url: fc.webUrl(),
              anchorText: fc.string(),
              statusCode: fc.integer({ min: 100, max: 599 }),
            }),
            { minLength: 1, maxLength: 30 }
          ),
          (linkResults) => {
            // Reset DOM for each run
            setupReportDOM();

            renderReportView(makeCheckResult({ linkResults }));

            const linksList = document.getElementById('report-links-list');
            const items = linksList.querySelectorAll('li');

            expect(items.length).toBe(linkResults.length);

            for (let i = 0; i < linkResults.length; i++) {
              const itemText = items[i].textContent;
              const expectedCode = String(linkResults[i].statusCode);
              expect(itemText).toContain(expectedCode);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 4: Report_View does not display a status code for non-http_error broken links
// Feature: show-status-code-all-links, Property 4: Report_View does not display a status code for non-http_error broken links
// Validates: Requirements 3.3
// ---------------------------------------------------------------------------

describe('Property 4: Report_View does not display a status code for non-http_error broken links', () => {
  beforeEach(() => {
    setupReportDOM();
  });

  /**
   * **Validates: Requirements 3.3**
   *
   * For any array of broken link results where reason.type is one of
   * 'timeout', 'network_error', or 'content_404' (no statusCode in reason),
   * each rendered <li> in #report-links-list must NOT contain a 3-digit HTTP
   * status code string matching /\b[1-5]\d{2}\b/.
   */
  test(
    'Feature: show-status-code-all-links, Property 4: Report_View does not display a status code for non-http_error broken links — ' +
      'each rendered <li> text does not match /\\b[1-5]\\d{2}\\b/ (no 3-digit HTTP status code)',
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              status: fc.constant('broken'),
              url: fc.webUrl(),
              anchorText: fc.string(),
              reason: fc.oneof(
                fc.record({ type: fc.constant('timeout') }),
                fc.record({ type: fc.constant('network_error'), message: fc.string() }),
                fc.record({ type: fc.constant('content_404') })
              ),
            }),
            { minLength: 1, maxLength: 30 }
          ),
          (linkResults) => {
            // Reset DOM for each run
            setupReportDOM();

            renderReportView(makeCheckResult({ linkResults }));

            const linksList = document.getElementById('report-links-list');
            const items = linksList.querySelectorAll('li');

            expect(items.length).toBe(linkResults.length);

            for (const item of items) {
              // Only check the status badge and description — not the URL span.
              // URLs can contain digit sequences that look like status codes
              // (e.g. "http://100.a.aa"), so we must exclude them from the assertion.
              const badge = item.querySelector('.link-result__status');
              const description = item.querySelector('.result-item__description');
              const badgeText = badge ? badge.textContent : '';
              const descriptionText = description ? description.textContent : '';
              const relevantText = badgeText + descriptionText;
              expect(relevantText).not.toMatch(/\b[1-5]\d{2}\b/);
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
