/**
 * Unit tests for popup rendering functions.
 *
 * These tests validate the DOM rendering behaviour of popup/popup.js.
 * They are written BEFORE the rendering implementation (TDD) and are
 * expected to FAIL until task 10.6 is complete.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Chrome API mock — must be set up before importing popup.js
// ---------------------------------------------------------------------------

const mockStorageGet = vi.fn();
const mockStorageSet = vi.fn();
const mockStorageOnChangedAddListener = vi.fn();
const mockRuntimeSendMessage = vi.fn();

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
  },
});

// ---------------------------------------------------------------------------
// Import rendering functions from popup.js
// These imports will fail (or the functions will be undefined) until 10.6
// ---------------------------------------------------------------------------

import {
  renderPopup,
  initPopup,
} from "../../popup/popup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal CheckResult for use in tests.
 * @param {object} overrides
 * @returns {import('../types.js').CheckResult}
 */
function makeCheckResult(overrides = {}) {
  return {
    pageUrl: "https://example.com/course",
    pageTitle: "Example Course",
    brokenLinks: [],
    outdatedSections: [],
    fixSuggestions: [],
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Builds a BrokenLink record.
 */
function makeBrokenLink(url = "https://example.com/dead", anchorText = "Dead link") {
  return {
    url,
    anchorText,
    reason: { type: "http_error", statusCode: 404 },
  };
}

/**
 * Builds an OutdatedSection record.
 */
function makeOutdatedSection(sectionText = "Use the old API", severity = "high") {
  return {
    sectionText,
    reason: "This API has been deprecated.",
    severity,
  };
}

/**
 * Builds a FixSuggestion for a broken link.
 */
function makeBrokenLinkSuggestion(url = "https://example.com/dead", anchorText = "Dead link") {
  return {
    problemType: "broken_link",
    severity: "high",
    location: anchorText || url,
    description: `Link is broken: http_error. URL: ${url}`,
  };
}

/**
 * Builds a FixSuggestion for an outdated section.
 */
function makeOutdatedSuggestion(sectionText = "Use the old API", severity = "medium") {
  return {
    problemType: "outdated_section",
    severity,
    location: sectionText.slice(0, 80),
    description: "This API has been deprecated.",
  };
}

/**
 * Sets up a minimal popup DOM structure that renderPopup() can operate on.
 * The actual HTML will be defined in popup.html (task 10.5); this helper
 * creates the minimum required elements for the rendering tests.
 */
function setupPopupDOM() {
  document.body.innerHTML = `
    <div id="popup-root">
      <div id="idle-view" class="view">
        <button id="run-check-btn">Run Check</button>
      </div>
      <div id="loading-view" class="view" hidden>
        <div id="loading-indicator" role="status" aria-live="polite">
          <span id="loading-phase-label"></span>
        </div>
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
// Test suite
// ---------------------------------------------------------------------------

describe("popup rendering", () => {
  beforeEach(() => {
    setupPopupDOM();
    vi.clearAllMocks();
    mockStorageGet.mockImplementation((_keys, cb) => cb({}));
    mockRuntimeSendMessage.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Test 1: zero broken links and zero outdated sections shows "No problems found"
  // Requirement 4.4
  // -------------------------------------------------------------------------
  test("zero broken links and zero outdated sections shows 'No problems found' message", () => {
    const popupState = {
      status: "complete",
      result: makeCheckResult({
        brokenLinks: [],
        outdatedSections: [],
        fixSuggestions: [],
      }),
    };

    renderPopup(popupState);

    const noProblemsMsg = document.getElementById("no-problems-message");
    expect(noProblemsMsg).not.toBeNull();
    expect(noProblemsMsg.hidden).toBe(false);
    expect(noProblemsMsg.textContent).toMatch(/no problems found/i);
  });

  // -------------------------------------------------------------------------
  // Test 2: loading state shows loading indicator
  // Requirement 4.5
  // -------------------------------------------------------------------------
  test("loading state shows loading indicator", () => {
    const popupState = {
      status: "loading",
      progress: { phase: "checking_links" },
    };

    renderPopup(popupState);

    const loadingView = document.getElementById("loading-view");
    const loadingIndicator = document.getElementById("loading-indicator");

    expect(loadingView).not.toBeNull();
    expect(loadingView.hidden).toBe(false);
    expect(loadingIndicator).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3: semanticCheckError present shows error banner above results
  // Requirement 2.7
  // -------------------------------------------------------------------------
  test("semanticCheckError present shows error banner above results", () => {
    const errorMessage = "Semantic check timed out — re-run the check to try again.";
    const brokenLink = makeBrokenLink();
    const popupState = {
      status: "complete",
      result: makeCheckResult({
        brokenLinks: [brokenLink],
        outdatedSections: [],
        fixSuggestions: [makeBrokenLinkSuggestion()],
        semanticCheckError: errorMessage,
      }),
    };

    renderPopup(popupState);

    const errorBanner = document.getElementById("error-banner");
    expect(errorBanner).not.toBeNull();
    expect(errorBanner.hidden).toBe(false);
    expect(errorBanner.textContent).toContain(errorMessage);

    // Error banner must appear before the results sections in the DOM
    const completeView = document.getElementById("complete-view");
    const children = Array.from(completeView.children);
    const bannerIndex = children.indexOf(errorBanner);
    const brokenLinksSection = document.getElementById("broken-links-section");
    const brokenLinksIndex = children.indexOf(brokenLinksSection);
    expect(bannerIndex).toBeLessThan(brokenLinksIndex);
  });

  // -------------------------------------------------------------------------
  // Test 4: broken links appear before semantic issues in the rendered output
  // Requirement 4.2
  // -------------------------------------------------------------------------
  test("broken links appear before semantic issues in the rendered output", () => {
    const popupState = {
      status: "complete",
      result: makeCheckResult({
        brokenLinks: [makeBrokenLink()],
        outdatedSections: [makeOutdatedSection()],
        fixSuggestions: [
          makeBrokenLinkSuggestion(),
          makeOutdatedSuggestion(),
        ],
      }),
    };

    renderPopup(popupState);

    const completeView = document.getElementById("complete-view");
    const children = Array.from(completeView.querySelectorAll("section, [id]"));

    const brokenLinksSection = document.getElementById("broken-links-section");
    const semanticSection = document.getElementById("semantic-issues-section");

    expect(brokenLinksSection).not.toBeNull();
    expect(semanticSection).not.toBeNull();

    // Broken links section must appear before semantic issues section in the DOM
    const allElements = Array.from(completeView.querySelectorAll("*"));
    const brokenLinksPos = allElements.indexOf(brokenLinksSection);
    const semanticPos = allElements.indexOf(semanticSection);
    expect(brokenLinksPos).toBeLessThan(semanticPos);

    // Both sections must have rendered items
    const brokenLinkItems = document.querySelectorAll("#broken-links-list li");
    const semanticItems = document.querySelectorAll("#semantic-issues-list li");
    expect(brokenLinkItems.length).toBe(1);
    expect(semanticItems.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 5: severity summary counts match the FixSuggestion entries in the result
  // Requirement 4.3
  // -------------------------------------------------------------------------
  test("severity summary counts match the FixSuggestion entries in the result", () => {
    const fixSuggestions = [
      makeBrokenLinkSuggestion("https://a.com", "Link A"),   // high
      makeBrokenLinkSuggestion("https://b.com", "Link B"),   // high
      makeOutdatedSuggestion("Old API call", "medium"),       // medium
      makeOutdatedSuggestion("Slightly stale note", "low"),   // low
    ];

    const popupState = {
      status: "complete",
      result: makeCheckResult({
        brokenLinks: [
          makeBrokenLink("https://a.com", "Link A"),
          makeBrokenLink("https://b.com", "Link B"),
        ],
        outdatedSections: [
          makeOutdatedSection("Old API call", "medium"),
          makeOutdatedSection("Slightly stale note", "low"),
        ],
        fixSuggestions,
      }),
    };

    renderPopup(popupState);

    const highCount = document.getElementById("summary-high");
    const mediumCount = document.getElementById("summary-medium");
    const lowCount = document.getElementById("summary-low");

    expect(highCount).not.toBeNull();
    expect(mediumCount).not.toBeNull();
    expect(lowCount).not.toBeNull();

    expect(highCount.textContent).toBe("2");
    expect(mediumCount.textContent).toBe("1");
    expect(lowCount.textContent).toBe("1");
  });

  // -------------------------------------------------------------------------
  // Test 6: popup re-open with status "complete" renders stored result
  //         without sending START_CHECK
  // Requirement 4.4, 4.6
  // -------------------------------------------------------------------------
  test("popup re-open with status 'complete' renders stored result without sending START_CHECK", async () => {
    const storedResult = makeCheckResult({
      brokenLinks: [makeBrokenLink()],
      outdatedSections: [],
      fixSuggestions: [makeBrokenLinkSuggestion()],
    });

    // Simulate storage returning a completed check state
    mockStorageGet.mockImplementation((_keys, cb) => {
      cb({
        checkState: {
          status: "complete",
          result: storedResult,
        },
      });
    });

    // initPopup() reads from storage and renders — it must NOT send START_CHECK
    await initPopup();

    // The complete view should be visible with the stored result
    const completeView = document.getElementById("complete-view");
    expect(completeView.hidden).toBe(false);

    // START_CHECK must NOT have been sent
    const startCheckCalls = mockRuntimeSendMessage.mock.calls.filter(
      ([msg]) => msg && msg.type === "START_CHECK"
    );
    expect(startCheckCalls.length).toBe(0);

    // The broken link from the stored result should be rendered
    const brokenLinkItems = document.querySelectorAll("#broken-links-list li");
    expect(brokenLinkItems.length).toBe(1);
  });
});
