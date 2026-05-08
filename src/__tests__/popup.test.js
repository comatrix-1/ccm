import { describe, test, expect } from "vitest";
import { checkStateToPopupState } from "../../popup/popup.js";

// ---------------------------------------------------------------------------
// Unit tests — checkStateToPopupState()
// Validates: Requirements 4.4, 4.5, 4.6
// ---------------------------------------------------------------------------

describe("checkStateToPopupState()", () => {
  // -------------------------------------------------------------------------
  // Test 1: undefined state maps to { status: "idle" }
  // -------------------------------------------------------------------------
  test("undefined state maps to { status: 'idle' }", () => {
    const result = checkStateToPopupState(undefined, Date.now());
    expect(result).toEqual({ status: "idle" });
  });

  // -------------------------------------------------------------------------
  // Test 2: in_progress with startedAt 30s ago maps to { status: "loading" }
  // -------------------------------------------------------------------------
  test("in_progress with startedAt 30s ago maps to { status: 'loading' } with phase info", () => {
    const now = Date.now();
    const startedAt = now - 30_000; // 30 seconds ago — within the 60s threshold
    const state = {
      status: "in_progress",
      phase: "checking_links",
      startedAt,
    };

    const result = checkStateToPopupState(state, now);

    expect(result.status).toBe("loading");
    expect(result.progress).toBeDefined();
    expect(result.progress.phase).toBe("checking_links");
  });

  // -------------------------------------------------------------------------
  // Test 3: in_progress with startedAt 61s ago maps to error (Requirement 4.6)
  // -------------------------------------------------------------------------
  test("in_progress with startedAt 61s ago maps to { status: 'error', message: 'Check was interrupted — run again?' }", () => {
    const now = Date.now();
    const startedAt = now - 61_000; // 61 seconds ago — exceeds the 60s threshold
    const state = {
      status: "in_progress",
      phase: "semantic_check",
      startedAt,
    };

    const result = checkStateToPopupState(state, now);

    expect(result.status).toBe("error");
    expect(result.message).toBe("Check was interrupted — run again?");
  });

  // -------------------------------------------------------------------------
  // Test 4: complete state maps to { status: "complete", result }
  // -------------------------------------------------------------------------
  test("complete state maps to { status: 'complete', result }", () => {
    const now = Date.now();
    const checkResult = {
      pageUrl: "https://example.com/course",
      pageTitle: "Example Course",
      brokenLinks: [],
      outdatedSections: [],
      fixSuggestions: [],
      checkedAt: new Date().toISOString(),
    };
    const state = {
      status: "complete",
      result: checkResult,
    };

    const result = checkStateToPopupState(state, now);

    expect(result.status).toBe("complete");
    expect(result.result).toEqual(checkResult);
  });
});
