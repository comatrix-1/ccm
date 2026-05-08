/**
 * Property-based tests for the selective-check-buttons feature.
 *
 * Feature: selective-check-buttons
 *
 * Properties covered in this file:
 *   Property 2: Link-only result has empty outdatedSections and only broken-link fix suggestions
 *   Property 4: Complete view hides the Semantic Issues section when outdatedSections is empty
 *   Property 5: Complete view hides the Broken Links section when brokenLinks is empty
 *
 * Validates: Requirements 4.2, 7.1, 7.2
 */

import { describe, test, beforeEach, vi } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Chrome API mock — must be set up before importing popup.js / background.js
// ---------------------------------------------------------------------------

const mockStorageGet = vi.fn();
const mockStorageSet = vi.fn();
const mockStorageOnChangedAddListener = vi.fn();
const mockRuntimeSendMessage = vi.fn();

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
vi.mock('../../src/tokenizer.js', () => ({
  countTokens: vi.fn().mockReturnValue(0),
}));
vi.mock('../../src/pageExtractor.js', () => ({}));

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: mockStorageGet,
      set: mockStorageSet,
    },
    onChanged: {
      addListener: mockStorageOnChangedAddListener,
    },
  },
  runtime: {
    sendMessage: mockRuntimeSendMessage,
    onMessage: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    sendMessage: vi.fn(),
    query: vi.fn(),
  },
});

const { handleStartLinkCheck, handleStartSemanticCheck } = await import('../../background.js');
const { checkLinks } = await import('../../src/linkChecker.js');
const { runSemanticCheck } = await import('../../src/semanticChecker.js');
const { generateBrokenLinkSuggestion, generateOutdatedSectionSuggestion } = await import('../../src/fixSuggestions.js');

import { renderPopup } from "../../popup/popup.js";
import { resolveCheckMode } from "../../popup/popup.js";

// ---------------------------------------------------------------------------
// DOM setup helper
// ---------------------------------------------------------------------------

function setupPopupDOM() {
  document.body.innerHTML = `
    <div id="popup-root">
      <div id="idle-view" class="view">
        <button id="run-check-btn">Run Check</button>
      </div>
      <div id="loading-view" class="view" hidden>
        <span id="loading-phase-label"></span>
      </div>
      <div id="complete-view" class="view" hidden>
        <div id="error-banner" hidden></div>
        <div id="severity-summary">
          <span id="summary-high">0</span>
          <span id="summary-medium">0</span>
          <span id="summary-low">0</span>
        </div>
        <section id="broken-links-section">
          <h2>Broken Links</h2>
          <ul id="broken-links-list"></ul>
        </section>
        <section id="semantic-issues-section">
          <h2>Semantic Issues</h2>
          <ul id="semantic-issues-list"></ul>
        </section>
        <div id="no-problems-message" hidden>No problems found</div>
      </div>
      <div id="error-view" class="view" hidden>
        <p id="error-message"></p>
      </div>
    </div>
    <div id="settings-panel">
      <input id="api-key-input" type="password" />
      <button id="save-api-key-btn">Save</button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const severityArb = fc.oneof(
  fc.constant("high"),
  fc.constant("medium"),
  fc.constant("low")
);

const brokenLinkReasonArb = fc.oneof(
  fc.record({
    type: fc.constant("http_error"),
    statusCode: fc.integer({ min: 400, max: 599 }),
  }),
  fc.constant({ type: "timeout" }),
  fc.record({
    type: fc.constant("redirect_loop"),
    hopCount: fc.integer({ min: 6, max: 20 }),
  }),
  fc.record({
    type: fc.constant("network_error"),
    message: fc.string({ minLength: 1 }),
  })
);

const brokenLinkArb = fc.record({
  url: fc.webUrl(),
  anchorText: fc.string(),
  reason: brokenLinkReasonArb,
});

const outdatedSectionArb = fc.record({
  sectionText: fc.string({ minLength: 1, maxLength: 200 }),
  reason: fc.string({ minLength: 1 }),
  severity: severityArb,
});

// ---------------------------------------------------------------------------
// Property 2: Link-only result has empty outdatedSections and only broken-link fix suggestions
// Feature: selective-check-buttons, Property 2
// ---------------------------------------------------------------------------

describe("Property 2: Link-only result has empty outdatedSections and only broken-link fix suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSet.mockResolvedValue(undefined);
    chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
    chrome.tabs.sendMessage.mockResolvedValue({
      type: 'PAGE_DATA',
      payload: {
        links: [],
        textContent: 'Some page text.',
        pageUrl: 'https://example.com/course',
        pageTitle: 'Example Course',
      },
    });
  });

  /**
   * **Property 2: Link-only result has empty outdatedSections and only broken-link fix suggestions**
   * **Validates: Requirements 4.2**
   */
  test(
    "for any array of BrokenLink objects (0–20 items), handleStartLinkCheck result has " +
      "outdatedSections === [] and every fixSuggestions entry has problemType === 'broken_link'",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              url: fc.webUrl(),
              anchorText: fc.string(),
              reason: fc.record({
                type: fc.constant("http_error"),
                statusCode: fc.integer({ min: 400, max: 599 }),
              }),
            }),
            { minLength: 0, maxLength: 20 }
          ),
          async (brokenLinks) => {
            vi.clearAllMocks();
            mockStorageSet.mockResolvedValue(undefined);
            chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
            chrome.tabs.sendMessage.mockResolvedValue({
              type: 'PAGE_DATA',
              payload: {
                links: brokenLinks.map(l => ({ url: l.url, anchorText: l.anchorText, rawHref: l.url })),
                textContent: 'Some page text.',
                pageUrl: 'https://example.com/course',
                pageTitle: 'Example Course',
              },
            });

            // checkLinks returns the brokenLinks as broken results
            checkLinks.mockResolvedValue(
              brokenLinks.map(link => ({ status: 'broken', link }))
            );

            // runSemanticCheck should NOT be called — mock it to throw if called
            runSemanticCheck.mockImplementation(() => {
              throw new Error('runSemanticCheck should not be called in link-only mode');
            });

            // generateBrokenLinkSuggestion returns a broken_link suggestion for each
            generateBrokenLinkSuggestion.mockImplementation(async (link) => ({
              problemType: 'broken_link',
              severity: 'high',
              location: link.anchorText || link.url,
              description: `Link is broken: ${link.reason.type}.`,
            }));

            await handleStartLinkCheck({ tab: { id: 1 } });

            const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
            const finalState = lastCall[0].checkState;

            expect(finalState.status).toBe('complete');
            expect(finalState.result.outdatedSections).toEqual([]);
            expect(
              finalState.result.fixSuggestions.every(s => s.problemType === 'broken_link')
            ).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 4: Complete view hides Semantic Issues section when outdatedSections is empty
// Feature: selective-check-buttons, Property 4
// ---------------------------------------------------------------------------

describe("Property 4: Complete view hides the Semantic Issues section when outdatedSections is empty", () => {
  beforeEach(() => {
    setupPopupDOM();
    vi.clearAllMocks();
  });

  /**
   * **Property 4: Complete view hides the Semantic Issues section when outdatedSections is empty**
   * **Validates: Requirements 7.1**
   */
  test(
    "for any CheckResult with outdatedSections: [] and random brokenLinks (0–10 items), " +
      "the semantic-issues-section element is hidden",
    () => {
      fc.assert(
        fc.property(
          fc.array(brokenLinkArb, { minLength: 0, maxLength: 10 }),
          (brokenLinks) => {
            setupPopupDOM();

            /** @type {import('../types.js').CheckResult} */
            const result = {
              pageUrl: "https://example.com/course",
              pageTitle: "Example Course",
              brokenLinks,
              outdatedSections: [],
              fixSuggestions: [],
              checkedAt: new Date().toISOString(),
            };

            renderPopup({ status: "complete", result });

            const semanticIssuesSection = document.getElementById(
              "semantic-issues-section"
            );
            expect(semanticIssuesSection).not.toBeNull();
            expect(semanticIssuesSection.hidden).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 5: Complete view hides Broken Links section when brokenLinks is empty
// Feature: selective-check-buttons, Property 5
// ---------------------------------------------------------------------------

describe("Property 5: Complete view hides the Broken Links section when brokenLinks is empty", () => {
  beforeEach(() => {
    setupPopupDOM();
    vi.clearAllMocks();
  });

  /**
   * **Property 5: Complete view hides the Broken Links section when brokenLinks is empty**
   * **Validates: Requirements 7.2**
   */
  test(
    "for any CheckResult with brokenLinks: [] and random outdatedSections (0–10 items), " +
      "the broken-links-section element is hidden",
    () => {
      fc.assert(
        fc.property(
          fc.array(outdatedSectionArb, { minLength: 0, maxLength: 10 }),
          (outdatedSections) => {
            setupPopupDOM();

            /** @type {import('../types.js').CheckResult} */
            const result = {
              pageUrl: "https://example.com/course",
              pageTitle: "Example Course",
              brokenLinks: [],
              outdatedSections,
              fixSuggestions: [],
              checkedAt: new Date().toISOString(),
            };

            renderPopup({ status: "complete", result });

            const brokenLinksSection = document.getElementById(
              "broken-links-section"
            );
            expect(brokenLinksSection).not.toBeNull();
            expect(brokenLinksSection.hidden).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 1: Checkbox state determines the correct message type
// Feature: selective-check-buttons, Property 1
// ---------------------------------------------------------------------------

describe("Property 1: Checkbox state determines the correct message type", () => {
  /**
   * **Property 1: Checkbox state determines the correct message type**
   * **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 2.3, 2.4, 2.5, 2.6, 3.3, 3.4, 3.5, 3.6**
   */
  test(
    "for any combination of linksChecked and semanticChecked booleans, " +
      "resolveCheckMode returns the correct message type",
    () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.boolean(),
          (linksChecked, semanticChecked) => {
            const result = resolveCheckMode(linksChecked, semanticChecked);
            if (linksChecked && semanticChecked) {
              expect(result).toBe("START_CHECK");
            } else if (linksChecked) {
              expect(result).toBe("START_LINK_CHECK");
            } else if (semanticChecked) {
              expect(result).toBe("START_SEMANTIC_CHECK");
            } else {
              expect(result).toBeNull();
            }
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 3: Semantic-only result has empty brokenLinks and only outdated-section fix suggestions
// Feature: selective-check-buttons, Property 3
// ---------------------------------------------------------------------------

describe("Property 3: Semantic-only result has empty brokenLinks and only outdated-section fix suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSet.mockResolvedValue(undefined);
    chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
    chrome.tabs.sendMessage.mockResolvedValue({
      type: 'PAGE_DATA',
      payload: {
        links: [],
        textContent: 'Some page text.',
        pageUrl: 'https://example.com/course',
        pageTitle: 'Example Course',
      },
    });
  });

  /**
   * **Property 3: Semantic-only result has empty brokenLinks and only outdated-section fix suggestions**
   * **Validates: Requirements 5.2**
   */
  test(
    "for any array of OutdatedSection objects (0–20 items), handleStartSemanticCheck result has " +
      "brokenLinks === [] and every fixSuggestions entry has problemType === 'outdated_section'",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              sectionText: fc.string({ minLength: 1, maxLength: 200 }),
              reason: fc.string({ minLength: 1 }),
              severity: fc.oneof(
                fc.constant("high"),
                fc.constant("medium"),
                fc.constant("low")
              ),
            }),
            { minLength: 0, maxLength: 20 }
          ),
          async (outdatedSections) => {
            vi.clearAllMocks();
            mockStorageSet.mockResolvedValue(undefined);
            chrome.tabs.query.mockResolvedValue([{ id: 1 }]);
            chrome.tabs.sendMessage.mockResolvedValue({
              type: 'PAGE_DATA',
              payload: {
                links: [],
                textContent: outdatedSections.map(s => s.sectionText).join(' ') || 'Some page text.',
                pageUrl: 'https://example.com/course',
                pageTitle: 'Example Course',
              },
            });

            // runSemanticCheck returns the outdatedSections
            runSemanticCheck.mockResolvedValue({ outdatedSections });

            // checkLinks should NOT be called — mock it to throw if called
            checkLinks.mockImplementation(() => {
              throw new Error('checkLinks should not be called in semantic-only mode');
            });

            // generateOutdatedSectionSuggestion returns an outdated_section suggestion for each
            generateOutdatedSectionSuggestion.mockImplementation((section) => ({
              problemType: 'outdated_section',
              severity: section.severity,
              location: section.sectionText.slice(0, 50),
              description: section.reason,
            }));

            await handleStartSemanticCheck({ tab: { id: 1 } });

            const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
            const finalState = lastCall[0].checkState;

            expect(finalState.status).toBe('complete');
            expect(finalState.result.brokenLinks).toEqual([]);
            expect(
              finalState.result.fixSuggestions.every(s => s.problemType === 'outdated_section')
            ).toBe(true);
          }
        ),
        { numRuns: 50 }
      );
    }
  );
});
