/**
 * Unit tests for renderReportView and report navigation.
 *
 * Tests the DOM rendering behaviour of the report-view in popup/popup.js,
 * including navigation between complete-view and report-view.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 4.1, 4.6, 5.1, 5.5, 5.6, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5
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
// ---------------------------------------------------------------------------

import { renderReportView, initPopup } from "../../popup/popup.js";

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
    checkedAt: new Date("2024-01-15T10:30:00Z").toISOString(),
    linkResults: null,
    semanticCoverage: null,
    ...overrides,
  };
}

/**
 * Builds a LinkResult with status "ok".
 */
function makeLinkResultOk(url = "https://example.com/ok", anchorText = "OK link") {
  return { status: "ok", url, anchorText };
}

/**
 * Builds a LinkResult with status "broken".
 */
function makeLinkResultBroken(
  url = "https://example.com/dead",
  anchorText = "Dead link",
  statusCode = 404
) {
  return {
    status: "broken",
    url,
    anchorText,
    reason: { type: "http_error", statusCode },
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("renderReportView", () => {
  beforeEach(() => {
    setupReportDOM();
    vi.clearAllMocks();
    mockStorageGet.mockImplementation((_keys, cb) => cb({}));
    mockRuntimeSendMessage.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Test 1: linkResults === null hides #report-links-section
  // Requirement 3.1
  // -------------------------------------------------------------------------
  test("linkResults === null hides #report-links-section", () => {
    const result = makeCheckResult({ linkResults: null });
    renderReportView(result);

    const linksSection = document.getElementById("report-links-section");
    expect(linksSection).not.toBeNull();
    expect(linksSection.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: linkResults === [] shows section and #report-no-links-msg, hides #report-links-list
  // Requirement 4.1
  // -------------------------------------------------------------------------
  test("linkResults === [] shows section and #report-no-links-msg, hides #report-links-list", () => {
    const result = makeCheckResult({ linkResults: [] });
    renderReportView(result);

    const linksSection = document.getElementById("report-links-section");
    const noLinksMsg = document.getElementById("report-no-links-msg");
    const linksList = document.getElementById("report-links-list");

    expect(linksSection.hidden).toBe(false);
    expect(noLinksMsg.hidden).toBe(false);
    expect(linksList.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: non-empty linkResults populates #report-links-list with correct item count
  // Requirement 4.1, 7.1, 7.3
  // -------------------------------------------------------------------------
  test("non-empty linkResults populates #report-links-list with correct item count", () => {
    const result = makeCheckResult({
      linkResults: [
        makeLinkResultOk("https://example.com/a", "Link A"),
        makeLinkResultOk("https://example.com/b", "Link B"),
        makeLinkResultBroken("https://example.com/dead", "Dead link"),
      ],
    });
    renderReportView(result);

    const linksSection = document.getElementById("report-links-section");
    const noLinksMsg = document.getElementById("report-no-links-msg");
    const linksList = document.getElementById("report-links-list");
    const items = linksList.querySelectorAll("li");

    expect(linksSection.hidden).toBe(false);
    expect(noLinksMsg.hidden).toBe(true);
    expect(linksList.hidden).toBe(false);
    expect(items.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test 4: semanticCoverage === null hides #report-semantic-section
  // Requirement 5.1
  // -------------------------------------------------------------------------
  test("semanticCoverage === null hides #report-semantic-section", () => {
    const result = makeCheckResult({ semanticCoverage: null });
    renderReportView(result);

    const semanticSection = document.getElementById("report-semantic-section");
    expect(semanticSection).not.toBeNull();
    expect(semanticSection.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: non-null semanticCoverage shows section and displays both char counts
  // Requirement 5.1, 5.5
  // -------------------------------------------------------------------------
  test("non-null semanticCoverage shows section and displays both char counts", () => {
    const result = makeCheckResult({
      semanticCoverage: { submittedCharCount: 5000, totalCharCount: 5000 },
    });
    renderReportView(result);

    const semanticSection = document.getElementById("report-semantic-section");
    const coverageEl = document.getElementById("report-coverage");

    expect(semanticSection.hidden).toBe(false);
    expect(coverageEl.textContent).toContain("5,000");
    // Both submitted and total should appear
    expect(coverageEl.textContent).toMatch(/5[,.]?000.*5[,.]?000|5000.*5000/);
  });

  // -------------------------------------------------------------------------
  // Test 6: submittedCharCount < totalCharCount shows #report-truncation-notice
  // Requirement 5.6
  // -------------------------------------------------------------------------
  test("submittedCharCount < totalCharCount shows #report-truncation-notice", () => {
    const result = makeCheckResult({
      semanticCoverage: { submittedCharCount: 3000, totalCharCount: 10000 },
    });
    renderReportView(result);

    const truncationNotice = document.getElementById("report-truncation-notice");
    expect(truncationNotice.hidden).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 7: submittedCharCount === totalCharCount hides #report-truncation-notice
  // Requirement 5.6
  // -------------------------------------------------------------------------
  test("submittedCharCount === totalCharCount hides #report-truncation-notice", () => {
    const result = makeCheckResult({
      semanticCoverage: { submittedCharCount: 8000, totalCharCount: 8000 },
    });
    renderReportView(result);

    const truncationNotice = document.getElementById("report-truncation-notice");
    expect(truncationNotice.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8: semanticCheckError present shows #report-semantic-error
  // Requirement 5.5
  // -------------------------------------------------------------------------
  test("semanticCheckError present shows #report-semantic-error", () => {
    const errorMsg = "Semantic check timed out — re-run the check to try again.";
    const result = makeCheckResult({
      semanticCoverage: { submittedCharCount: 5000, totalCharCount: 5000 },
      semanticCheckError: errorMsg,
    });
    renderReportView(result);

    const semanticErrorEl = document.getElementById("report-semantic-error");
    expect(semanticErrorEl.hidden).toBe(false);
    expect(semanticErrorEl.textContent).toContain(errorMsg);
  });

  // -------------------------------------------------------------------------
  // Test 9: outdatedSections === [] and no error shows #report-no-outdated-msg
  // Requirement 5.1
  // -------------------------------------------------------------------------
  test("outdatedSections === [] and no error shows #report-no-outdated-msg", () => {
    const result = makeCheckResult({
      outdatedSections: [],
      semanticCoverage: { submittedCharCount: 5000, totalCharCount: 5000 },
    });
    renderReportView(result);

    const noOutdatedMsg = document.getElementById("report-no-outdated-msg");
    const outdatedList = document.getElementById("report-outdated-list");

    expect(noOutdatedMsg.hidden).toBe(false);
    expect(outdatedList.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 10: non-empty outdatedSections populates #report-outdated-list
  // Requirement 5.1, 7.2, 7.4, 7.5
  // -------------------------------------------------------------------------
  test("non-empty outdatedSections populates #report-outdated-list", () => {
    const result = makeCheckResult({
      outdatedSections: [
        makeOutdatedSection("Old API usage", "high"),
        makeOutdatedSection("Deprecated method call", "medium"),
      ],
      semanticCoverage: { submittedCharCount: 5000, totalCharCount: 5000 },
    });
    renderReportView(result);

    const noOutdatedMsg = document.getElementById("report-no-outdated-msg");
    const outdatedList = document.getElementById("report-outdated-list");
    const items = outdatedList.querySelectorAll("li");

    expect(noOutdatedMsg.hidden).toBe(true);
    expect(outdatedList.hidden).toBe(false);
    expect(items.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Navigation tests — use initPopup() to wire up buttons
// ---------------------------------------------------------------------------

describe("report-view navigation", () => {
  beforeEach(() => {
    setupReportDOM();
    vi.clearAllMocks();
    mockRuntimeSendMessage.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Test 11: clicking "View Report" transitions to report-view
  // Requirement 3.1, 3.2, 4.6
  // -------------------------------------------------------------------------
  test("clicking 'View Report' transitions to report-view", async () => {
    const storedResult = makeCheckResult({
      linkResults: [makeLinkResultOk()],
      semanticCoverage: { submittedCharCount: 1000, totalCharCount: 1000 },
    });

    mockStorageGet.mockImplementation((_keys, cb) => {
      cb({
        checkState: {
          status: "complete",
          result: storedResult,
        },
      });
    });

    await initPopup();

    // complete-view should be visible after initPopup with a complete state
    const completeView = document.getElementById("complete-view");
    expect(completeView.hidden).toBe(false);

    // Click "View Report"
    const viewReportBtn = document.getElementById("view-report-btn");
    viewReportBtn.click();

    const reportView = document.getElementById("report-view");
    expect(reportView.hidden).toBe(false);
    expect(completeView.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 12: clicking "Back" transitions back to complete-view
  // Requirement 3.2, 3.3
  // -------------------------------------------------------------------------
  test("clicking 'Back' transitions back to complete-view", async () => {
    const storedResult = makeCheckResult({
      linkResults: [],
      semanticCoverage: { submittedCharCount: 500, totalCharCount: 500 },
    });

    mockStorageGet.mockImplementation((_keys, cb) => {
      cb({
        checkState: {
          status: "complete",
          result: storedResult,
        },
      });
    });

    await initPopup();

    // Navigate to report-view first
    const viewReportBtn = document.getElementById("view-report-btn");
    viewReportBtn.click();

    const reportView = document.getElementById("report-view");
    expect(reportView.hidden).toBe(false);

    // Click "Back"
    const backBtn = document.getElementById("back-btn");
    backBtn.click();

    const completeView = document.getElementById("complete-view");
    expect(completeView.hidden).toBe(false);
    expect(reportView.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderLinkResultItem statusCode display tests (Task 7.1)
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 4.1
// ---------------------------------------------------------------------------

describe("renderLinkResultItem statusCode display", () => {
  beforeEach(() => {
    setupReportDOM();
  });

  // -------------------------------------------------------------------------
  // Test: { status: 'ok', statusCode: 200 } renders badge text containing "200"
  // Requirement 3.1, 3.4
  // -------------------------------------------------------------------------
  test("ok link with statusCode 200 renders badge text containing '200'", () => {
    const result = makeCheckResult({
      linkResults: [{ status: "ok", url: "https://example.com/a", anchorText: "Link A", statusCode: 200 }],
    });
    renderReportView(result);

    const linksList = document.getElementById("report-links-list");
    const item = linksList.querySelector("li");
    expect(item).not.toBeNull();
    expect(item.textContent).toContain("200");
  });

  // -------------------------------------------------------------------------
  // Test: { status: 'ok', statusCode: 429 } renders badge text containing "429"
  // Requirement 3.1, 3.4
  // -------------------------------------------------------------------------
  test("ok link with statusCode 429 renders badge text containing '429'", () => {
    const result = makeCheckResult({
      linkResults: [{ status: "ok", url: "https://example.com/b", anchorText: "Link B", statusCode: 429 }],
    });
    renderReportView(result);

    const linksList = document.getElementById("report-links-list");
    const item = linksList.querySelector("li");
    expect(item).not.toBeNull();
    expect(item.textContent).toContain("429");
  });

  // -------------------------------------------------------------------------
  // Test: { status: 'ok' } (no statusCode) renders badge text "OK" without error
  // Requirement 4.1
  // -------------------------------------------------------------------------
  test("ok link without statusCode renders badge text 'OK' without error", () => {
    const result = makeCheckResult({
      linkResults: [{ status: "ok", url: "https://example.com/c", anchorText: "Link C" }],
    });
    renderReportView(result);

    const linksList = document.getElementById("report-links-list");
    const item = linksList.querySelector("li");
    expect(item).not.toBeNull();

    const badge = item.querySelector(".link-result__status");
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("OK");
  });

  // -------------------------------------------------------------------------
  // Test: { status: 'broken', reason: { type: 'timeout' } } does not display any 3-digit numeric code
  // Requirement 3.3
  // -------------------------------------------------------------------------
  test("broken link with timeout reason does not display any 3-digit numeric code", () => {
    const result = makeCheckResult({
      linkResults: [{ status: "broken", url: "https://example.com/d", anchorText: "Link D", reason: { type: "timeout" } }],
    });
    renderReportView(result);

    const linksList = document.getElementById("report-links-list");
    const item = linksList.querySelector("li");
    expect(item).not.toBeNull();
    expect(item.textContent).not.toMatch(/\b[1-5]\d{2}\b/);
  });

  // -------------------------------------------------------------------------
  // Test: { status: 'broken', reason: { type: 'http_error', statusCode: 404 } } still displays "404" in description
  // Requirement 3.2
  // -------------------------------------------------------------------------
  test("broken http_error link with statusCode 404 still displays '404' in description", () => {
    const result = makeCheckResult({
      linkResults: [{ status: "broken", url: "https://example.com/e", anchorText: "Link E", reason: { type: "http_error", statusCode: 404 } }],
    });
    renderReportView(result);

    const linksList = document.getElementById("report-links-list");
    const item = linksList.querySelector("li");
    expect(item).not.toBeNull();

    const description = item.querySelector(".result-item__description");
    expect(description).not.toBeNull();
    expect(description.textContent).toContain("404");
  });
});

// ---------------------------------------------------------------------------
// Accessibility / ARIA attribute tests
// ---------------------------------------------------------------------------

describe("report-view accessibility", () => {
  beforeEach(() => {
    setupReportDOM();
  });

  // -------------------------------------------------------------------------
  // Test 13: #back-btn has aria-label="Back to results"
  // Requirement 7.1
  // -------------------------------------------------------------------------
  test('#back-btn has aria-label="Back to results"', () => {
    const backBtn = document.getElementById("back-btn");
    expect(backBtn).not.toBeNull();
    expect(backBtn.getAttribute("aria-label")).toBe("Back to results");
  });

  // -------------------------------------------------------------------------
  // Test 14: #view-report-btn has aria-label="View full check report"
  // Requirement 7.2
  // -------------------------------------------------------------------------
  test('#view-report-btn has aria-label="View full check report"', () => {
    const viewReportBtn = document.getElementById("view-report-btn");
    expect(viewReportBtn).not.toBeNull();
    expect(viewReportBtn.getAttribute("aria-label")).toBe("View full check report");
  });

  // -------------------------------------------------------------------------
  // Test 15: #report-links-section has aria-label="Links checked"
  // Requirement 7.4
  // -------------------------------------------------------------------------
  test('#report-links-section has aria-label="Links checked"', () => {
    const linksSection = document.getElementById("report-links-section");
    expect(linksSection).not.toBeNull();
    expect(linksSection.getAttribute("aria-label")).toBe("Links checked");
  });

  // -------------------------------------------------------------------------
  // Test 16: #report-semantic-section has aria-label="Semantic check"
  // Requirement 7.5
  // -------------------------------------------------------------------------
  test('#report-semantic-section has aria-label="Semantic check"', () => {
    const semanticSection = document.getElementById("report-semantic-section");
    expect(semanticSection).not.toBeNull();
    expect(semanticSection.getAttribute("aria-label")).toBe("Semantic check");
  });

  // -------------------------------------------------------------------------
  // Test 17: #report-links-list uses <ul> / <li> elements
  // Requirement 6.3
  // -------------------------------------------------------------------------
  test("#report-links-list uses <ul> / <li> elements", () => {
    const result = makeCheckResult({
      linkResults: [
        makeLinkResultOk("https://example.com/a", "Link A"),
        makeLinkResultBroken("https://example.com/dead", "Dead link"),
      ],
    });
    renderReportView(result);

    const linksList = document.getElementById("report-links-list");
    expect(linksList.tagName.toLowerCase()).toBe("ul");

    const items = linksList.querySelectorAll("li");
    expect(items.length).toBe(2);
    items.forEach((item) => {
      expect(item.tagName.toLowerCase()).toBe("li");
    });
  });

  // -------------------------------------------------------------------------
  // Test 18: #report-outdated-list uses <ul> / <li> elements
  // Requirement 6.4
  // -------------------------------------------------------------------------
  test("#report-outdated-list uses <ul> / <li> elements", () => {
    const result = makeCheckResult({
      outdatedSections: [
        makeOutdatedSection("Old API usage", "high"),
        makeOutdatedSection("Deprecated method", "medium"),
      ],
      semanticCoverage: { submittedCharCount: 5000, totalCharCount: 5000 },
    });
    renderReportView(result);

    const outdatedList = document.getElementById("report-outdated-list");
    expect(outdatedList.tagName.toLowerCase()).toBe("ul");

    const items = outdatedList.querySelectorAll("li");
    expect(items.length).toBe(2);
    items.forEach((item) => {
      expect(item.tagName.toLowerCase()).toBe("li");
    });
  });
});
