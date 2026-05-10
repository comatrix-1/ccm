/**
 * Property-based tests for the API key save feedback feature.
 *
 * Feature: api-key-save-feedback
 *
 * Property 1: Save button hidden when input matches stored key
 * Property 2: Save button visible when input differs from stored key
 * Property 3: Save hides button and persists key
 * Property 4: Input populated on load
 *
 * Validates: Requirements 1.1, 1.2, 2.1, 2.2, 2.3, 3.1, 3.2, 4.3
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Chrome API mock — must be set up before importing popup.js
// ---------------------------------------------------------------------------

const mockStorageLocalGet = vi.fn();
const mockStorageSessionGet = vi.fn();
const mockStorageSessionSet = vi.fn();
const mockStorageOnChangedAddListener = vi.fn();
const mockRuntimeSendMessage = vi.fn();

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: mockStorageLocalGet,
    },
    session: {
      get: mockStorageSessionGet,
      set: mockStorageSessionSet,
    },
    onChanged: {
      addListener: mockStorageOnChangedAddListener,
    },
  },
  runtime: {
    sendMessage: mockRuntimeSendMessage,
  },
});

import { initPopup } from "../../popup/popup.js";

// ---------------------------------------------------------------------------
// DOM setup helper — full settings panel + minimal popup structure
// ---------------------------------------------------------------------------

function setupDOM() {
  document.body.innerHTML = `
    <div id="popup-root">
      <div id="idle-view" class="view">
        <input type="checkbox" id="idle-check-links" checked />
        <input type="checkbox" id="idle-semantic-check" checked />
        <button id="run-check-btn" type="button">Run Check</button>
      </div>
      <div id="loading-view" class="view" hidden>
        <span id="loading-phase-label"></span>
      </div>
      <div id="complete-view" class="view" hidden>
        <div id="error-banner" hidden></div>
        <span id="summary-high">0</span>
        <span id="summary-medium">0</span>
        <span id="summary-low">0</span>
        <section id="broken-links-section"><ul id="broken-links-list"></ul></section>
        <section id="semantic-issues-section"><ul id="semantic-issues-list"></ul></section>
        <div id="no-problems-message" hidden>No problems found</div>
        <input type="checkbox" id="complete-check-links" checked />
        <input type="checkbox" id="complete-semantic-check" checked />
        <button id="rerun-check-btn" type="button">Run Again</button>
        <button id="view-report-btn" type="button">View Report</button>
      </div>
      <div id="error-view" class="view" hidden>
        <p id="error-message"></p>
        <input type="checkbox" id="error-check-links" checked />
        <input type="checkbox" id="error-semantic-check" checked />
        <button id="retry-check-btn" type="button">Try Again</button>
      </div>
    </div>

    <div id="settings-panel" class="settings-panel">
      <details class="settings-details">
        <summary class="settings-summary">Settings</summary>
        <div class="settings-content">
          <div class="settings-input-row">
            <input
              id="api-key-input"
              class="settings-input"
              type="password"
              placeholder="sk-…"
              autocomplete="off"
              spellcheck="false"
            />
            <button id="save-api-key-btn" class="btn btn-secondary btn--small" type="button" hidden>
              Save
            </button>
          </div>
        </div>
      </details>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a non-empty API key string (printable ASCII, no leading/trailing
 * whitespace so trim() is a no-op — keeps property assertions simple).
 */
const apiKeyArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/**
 * Arbitrary for a stored key that may be absent (undefined → no stored key)
 * or a non-empty string.
 */
const storedKeyArb = fc.option(apiKeyArb, { nil: undefined });

// ---------------------------------------------------------------------------
// Property 1: Save button hidden when input matches stored key
// Feature: api-key-save-feedback, Property 1: Save button hidden when input matches stored key
// Validates: Requirements 1.1, 1.2, 2.2
// ---------------------------------------------------------------------------

describe(
  "Feature: api-key-save-feedback, Property 1: Save button hidden when input matches stored key",
  () => {
    beforeEach(() => {
      setupDOM();
      vi.clearAllMocks();
      mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
      mockRuntimeSendMessage.mockResolvedValue(undefined);
    });

    test(
      "for any API key string, when the input value equals the stored key on load, " +
        "the Save button is hidden",
      async () => {
        await fc.assert(
          fc.asyncProperty(storedKeyArb, async (storedKey) => {
            setupDOM();
            vi.clearAllMocks();
            mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
            mockRuntimeSendMessage.mockResolvedValue(undefined);

            // Mock storage returning the stored key (or nothing when undefined)
            mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
            mockStorageSessionGet.mockImplementation((_keys, cb) =>
              cb(storedKey !== undefined ? { openrouterApiKey: storedKey } : {})
            );

            await initPopup();

            const saveBtn = document.getElementById("save-api-key-btn");
            expect(saveBtn.hidden).toBe(true);
          }),
          { numRuns: 100 }
        );
      }
    );
  }
);

// ---------------------------------------------------------------------------
// Property 2: Save button visible when input differs from stored key
// Feature: api-key-save-feedback, Property 2: Save button visible when input differs from stored key
// Validates: Requirements 2.1, 2.3
// ---------------------------------------------------------------------------

describe(
  "Feature: api-key-save-feedback, Property 2: Save button visible when input differs from stored key",
  () => {
    beforeEach(() => {
      setupDOM();
      vi.clearAllMocks();
      mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
      mockRuntimeSendMessage.mockResolvedValue(undefined);
    });

    test(
      "for any pair (storedKey, inputValue) where inputValue differs from storedKey, " +
        "typing inputValue into the API key input makes the Save button visible",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            // Generate a stored key (possibly absent) and an input value that differs
            fc
              .tuple(storedKeyArb, apiKeyArb)
              .filter(
                ([storedKey, inputValue]) =>
                  inputValue.trim() !== (storedKey ?? "").trim()
              ),
            async ([storedKey, inputValue]) => {
              setupDOM();
              vi.clearAllMocks();
              mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
              mockRuntimeSendMessage.mockResolvedValue(undefined);

              mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
              mockStorageSessionGet.mockImplementation((_keys, cb) =>
                cb(
                  storedKey !== undefined
                    ? { openrouterApiKey: storedKey }
                    : {}
                )
              );

              await initPopup();

              const saveBtn = document.getElementById("save-api-key-btn");
              const apiKeyInput = document.getElementById("api-key-input");

              // Simulate user typing a different value
              apiKeyInput.value = inputValue;
              apiKeyInput.dispatchEvent(new Event("input"));

              expect(saveBtn.hidden).toBe(false);
            }
          ),
          { numRuns: 100 }
        );
      }
    );
  }
);

// ---------------------------------------------------------------------------
// Property 3: Save hides button and persists key
// Feature: api-key-save-feedback, Property 3: Save hides button and persists key
// Validates: Requirements 3.1, 3.2
// ---------------------------------------------------------------------------

describe(
  "Feature: api-key-save-feedback, Property 3: Save hides button and persists key",
  () => {
    beforeEach(() => {
      setupDOM();
      vi.clearAllMocks();
      mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
      mockRuntimeSendMessage.mockResolvedValue(undefined);
    });

    test(
      "for any new key that differs from the stored key, clicking Save hides the button " +
        "and calls chrome.storage.session.set with the new key",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc
              .tuple(storedKeyArb, apiKeyArb)
              .filter(
                ([storedKey, newKey]) =>
                  newKey.trim() !== (storedKey ?? "").trim()
              ),
            async ([storedKey, newKey]) => {
              setupDOM();
              vi.clearAllMocks();
              mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
              mockRuntimeSendMessage.mockResolvedValue(undefined);

              mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
              mockStorageSessionGet.mockImplementation((_keys, cb) =>
                cb(
                  storedKey !== undefined
                    ? { openrouterApiKey: storedKey }
                    : {}
                )
              );

              await initPopup();

              const saveBtn = document.getElementById("save-api-key-btn");
              const apiKeyInput = document.getElementById("api-key-input");

              // Type the new key to make the button visible
              apiKeyInput.value = newKey;
              apiKeyInput.dispatchEvent(new Event("input"));
              expect(saveBtn.hidden).toBe(false);

              // Click Save
              saveBtn.click();

              // Button should be hidden after save
              expect(saveBtn.hidden).toBe(true);

              // Storage should have been called with the trimmed new key
              expect(mockStorageSessionSet).toHaveBeenCalledWith(
                { openrouterApiKey: newKey.trim() },
                expect.any(Function)
              );
            }
          ),
          { numRuns: 100 }
        );
      }
    );
  }
);

// ---------------------------------------------------------------------------
// Property 4: Input populated on load
// Feature: api-key-save-feedback, Property 4: Input populated on load
// Validates: Requirements 4.3
// ---------------------------------------------------------------------------

describe(
  "Feature: api-key-save-feedback, Property 4: Input populated on load",
  () => {
    beforeEach(() => {
      setupDOM();
      vi.clearAllMocks();
      mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
      mockRuntimeSendMessage.mockResolvedValue(undefined);
    });

    test(
      "for any API key string stored in chrome.storage.session, " +
        "the API key input is populated with that value after initPopup()",
      async () => {
        await fc.assert(
          fc.asyncProperty(apiKeyArb, async (key) => {
            setupDOM();
            vi.clearAllMocks();
            mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
            mockRuntimeSendMessage.mockResolvedValue(undefined);

            mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
            mockStorageSessionGet.mockImplementation((_keys, cb) =>
              cb({ openrouterApiKey: key })
            );

            await initPopup();

            const apiKeyInput = document.getElementById("api-key-input");
            expect(apiKeyInput.value).toBe(key);
          }),
          { numRuns: 100 }
        );
      }
    );
  }
);
