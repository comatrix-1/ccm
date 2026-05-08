/**
 * Property-based tests for popup rendering.
 *
 * These tests are written BEFORE the full rendering implementation (TDD) and are
 * expected to FAIL until task 10.6 is complete.
 *
 * Property 8: Popup renders all results
 * Property 9: Summary counts match result data
 *
 * Feature: course-content-monitor, Property 8: Popup renders all results
 * Feature: course-content-monitor, Property 9: Summary counts match result data
 *
 * Validates: Requirements 4.1, 4.2, 4.3
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import * as fc from "fast-check";

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
// Import renderPopup from popup.js
// This import will fail (or renderPopup will be undefined) until task 10.6
// ---------------------------------------------------------------------------

import { renderPopup } from "../../popup/popup.js";

// ---------------------------------------------------------------------------
// DOM setup helper
// Mirrors the structure defined in popup.rendering.test.js and popup.html (task 10.5)
// ---------------------------------------------------------------------------

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
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for Severity */
const severityArb = fc.oneof(
  fc.constant("high"),
  fc.constant("medium"),
  fc.constant("low")
);

/** Arbitrary for BrokenLinkReason */
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

/** Arbitrary for BrokenLink */
const brokenLinkArb = fc.record({
  url: fc.webUrl(),
  anchorText: fc.string(),
  reason: brokenLinkReasonArb,
});

/** Arbitrary for OutdatedSection */
const outdatedSectionArb = fc.record({
  sectionText: fc.string({ minLength: 1, maxLength: 200 }),
  reason: fc.string({ minLength: 1 }),
  severity: severityArb,
});

/** Arbitrary for a broken-link FixSuggestion */
const brokenLinkSuggestionArb = fc.record({
  problemType: fc.constant("broken_link"),
  severity: fc.constant("high"),
  location: fc.string({ minLength: 1 }),
  description: fc.string({ minLength: 1 }),
});

/** Arbitrary for an outdated-section FixSuggestion */
const outdatedSuggestionArb = fc.record({
  problemType: fc.constant("outdated_section"),
  severity: severityArb,
  location: fc.string({ minLength: 1 }),
  description: fc.string({ minLength: 1 }),
});

/** Arbitrary for any FixSuggestion */
const fixSuggestionArb = fc.oneof(brokenLinkSuggestionArb, outdatedSuggestionArb);

/**
 * Builds a CheckResult arbitrary with B broken links and S outdated sections,
 * plus matching FixSuggestion arrays.
 *
 * The fixSuggestions array is generated independently (not derived from the
 * broken links / outdated sections) to keep the property general — the popup
 * must render exactly what is in fixSuggestions, regardless of how it was built.
 */
const checkResultArb = fc
  .record({
    brokenLinks: fc.array(brokenLinkArb, { minLength: 0, maxLength: 10 }),
    outdatedSections: fc.array(outdatedSectionArb, { minLength: 0, maxLength: 10 }),
    // Generate fix suggestions independently so counts are the ground truth
    brokenLinkSuggestions: fc.array(brokenLinkSuggestionArb, {
      minLength: 0,
      maxLength: 10,
    }),
    outdatedSuggestions: fc.array(outdatedSuggestionArb, {
      minLength: 0,
      maxLength: 10,
    }),
    semanticCheckError: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  })
  .map(
    ({
      brokenLinks,
      outdatedSections,
      brokenLinkSuggestions,
      outdatedSuggestions,
      semanticCheckError,
    }) => {
      const fixSuggestions = [...brokenLinkSuggestions, ...outdatedSuggestions];
      /** @type {import('../types.js').CheckResult} */
      const result = {
        pageUrl: "https://example.com/course",
        pageTitle: "Example Course",
        brokenLinks,
        outdatedSections,
        fixSuggestions,
        checkedAt: new Date().toISOString(),
      };
      if (semanticCheckError !== undefined) {
        result.semanticCheckError = semanticCheckError;
      }
      return result;
    }
  );

// ---------------------------------------------------------------------------
// Property 8: Popup renders all results
// Feature: course-content-monitor, Property 8: Popup renders all results
// ---------------------------------------------------------------------------

describe("Property 8: Popup renders all results", () => {
  beforeEach(() => {
    setupPopupDOM();
    vi.clearAllMocks();
    mockStorageGet.mockImplementation((_keys, cb) => cb({}));
    mockRuntimeSendMessage.mockResolvedValue(undefined);
  });

  test(
    "for any CheckResult with B broken links and S outdated sections, " +
      "the popup displays exactly B broken link items and S semantic issue items, " +
      "with broken links before semantic issues; " +
      "when semanticCheckError is present, a non-empty error banner is also displayed",
    () => {
      fc.assert(
        fc.property(checkResultArb, (result) => {
          // Reset DOM for each iteration
          setupPopupDOM();

          const B = result.brokenLinks.length;
          const S = result.outdatedSections.length;

          const popupState = { status: "complete", result };
          renderPopup(popupState);

          // --- Broken link item count ---
          const brokenLinkItems = document.querySelectorAll(
            "#broken-links-list li"
          );
          expect(brokenLinkItems.length).toBe(B);

          // --- Semantic issue item count ---
          const semanticItems = document.querySelectorAll(
            "#semantic-issues-list li"
          );
          expect(semanticItems.length).toBe(S);

          // --- Ordering: broken links section before semantic issues section ---
          const completeView = document.getElementById("complete-view");
          const allElements = Array.from(completeView.querySelectorAll("*"));
          const brokenLinksSection = document.getElementById(
            "broken-links-section"
          );
          const semanticSection = document.getElementById(
            "semantic-issues-section"
          );
          expect(brokenLinksSection).not.toBeNull();
          expect(semanticSection).not.toBeNull();
          const brokenLinksPos = allElements.indexOf(brokenLinksSection);
          const semanticPos = allElements.indexOf(semanticSection);
          expect(brokenLinksPos).toBeLessThan(semanticPos);

          // --- Error banner when semanticCheckError is present ---
          const errorBanner = document.getElementById("error-banner");
          if (result.semanticCheckError !== undefined) {
            expect(errorBanner.hidden).toBe(false);
            expect(errorBanner.textContent.trim().length).toBeGreaterThan(0);
          } else {
            expect(errorBanner.hidden).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 9: Summary counts match result data
// Feature: course-content-monitor, Property 9: Summary counts match result data
// ---------------------------------------------------------------------------

describe("Property 9: Summary counts match result data", () => {
  beforeEach(() => {
    setupPopupDOM();
    vi.clearAllMocks();
    mockStorageGet.mockImplementation((_keys, cb) => cb({}));
    mockRuntimeSendMessage.mockResolvedValue(undefined);
  });

  test(
    "for any CheckResult, the severity summary counts displayed in the popup " +
      "equal the actual counts of FixSuggestion entries grouped by severity",
    () => {
      fc.assert(
        fc.property(
          fc.record({
            fixSuggestions: fc.array(fixSuggestionArb, {
              minLength: 0,
              maxLength: 20,
            }),
          }),
          ({ fixSuggestions }) => {
            // Reset DOM for each iteration
            setupPopupDOM();

            // Compute expected counts from the fixSuggestions array
            const expectedHigh = fixSuggestions.filter(
              (s) => s.severity === "high"
            ).length;
            const expectedMedium = fixSuggestions.filter(
              (s) => s.severity === "medium"
            ).length;
            const expectedLow = fixSuggestions.filter(
              (s) => s.severity === "low"
            ).length;

            /** @type {import('../types.js').CheckResult} */
            const result = {
              pageUrl: "https://example.com/course",
              pageTitle: "Example Course",
              brokenLinks: [],
              outdatedSections: [],
              fixSuggestions,
              checkedAt: new Date().toISOString(),
            };

            const popupState = { status: "complete", result };
            renderPopup(popupState);

            // Read displayed counts from the DOM
            const highEl = document.getElementById("summary-high");
            const mediumEl = document.getElementById("summary-medium");
            const lowEl = document.getElementById("summary-low");

            expect(highEl).not.toBeNull();
            expect(mediumEl).not.toBeNull();
            expect(lowEl).not.toBeNull();

            expect(Number(highEl.textContent)).toBe(expectedHigh);
            expect(Number(mediumEl.textContent)).toBe(expectedMedium);
            expect(Number(lowEl.textContent)).toBe(expectedLow);
          }
        ),
        { numRuns: 100 }
      );
    }
  );
});
