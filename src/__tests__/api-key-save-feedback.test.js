/**
 * Unit tests for the API key save feedback feature — settings panel behaviour.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 4.1, 4.2
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

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
// DOM setup helper — includes the full settings panel plus enough popup
// structure for initPopup() to work without errors
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
          <label class="settings-label" for="api-key-input">
            OpenRouter API Key
          </label>
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
// Tests
// ---------------------------------------------------------------------------

describe("api-key-save-feedback — settings panel behaviour", () => {
  beforeEach(() => {
    setupDOM();
    vi.clearAllMocks();
    // Default: no stored key, set callback is a no-op
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());
    mockRuntimeSendMessage.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // 1. Initial hidden state — no stored key
  // Requirements: 1.2, 1.3
  // -------------------------------------------------------------------------
  test("button hidden and input empty when no stored key exists", async () => {
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) => cb({}));

    await initPopup();

    const saveBtn = document.getElementById("save-api-key-btn");
    const apiKeyInput = document.getElementById("api-key-input");

    expect(saveBtn.hidden).toBe(true);
    expect(apiKeyInput.value).toBe("");
  });

  // -------------------------------------------------------------------------
  // 2. Initial hidden state — stored key matches input
  // Requirements: 1.1, 1.3, 4.3
  // -------------------------------------------------------------------------
  test("button hidden and input populated when stored key exists", async () => {
    const storedKey = "sk-test-key-abc123";
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) =>
      cb({ openrouterApiKey: storedKey })
    );

    await initPopup();

    const saveBtn = document.getElementById("save-api-key-btn");
    const apiKeyInput = document.getElementById("api-key-input");

    expect(saveBtn.hidden).toBe(true);
    expect(apiKeyInput.value).toBe(storedKey);
  });

  // -------------------------------------------------------------------------
  // 3. Keystroke visibility — shows button when value differs from stored key
  // Requirements: 2.1, 2.3
  // -------------------------------------------------------------------------
  test("button becomes visible when user types a value different from stored key", async () => {
    const storedKey = "sk-original-key";
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) =>
      cb({ openrouterApiKey: storedKey })
    );

    await initPopup();

    const saveBtn = document.getElementById("save-api-key-btn");
    const apiKeyInput = document.getElementById("api-key-input");

    // Confirm initially hidden
    expect(saveBtn.hidden).toBe(true);

    // Type a different value
    apiKeyInput.value = "sk-new-different-key";
    apiKeyInput.dispatchEvent(new Event("input"));

    expect(saveBtn.hidden).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. Keystroke visibility — hides button when value is restored to stored key
  // Requirements: 2.2, 2.3
  // -------------------------------------------------------------------------
  test("button hides again when user clears input back to the stored key value", async () => {
    const storedKey = "sk-original-key";
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) =>
      cb({ openrouterApiKey: storedKey })
    );

    await initPopup();

    const saveBtn = document.getElementById("save-api-key-btn");
    const apiKeyInput = document.getElementById("api-key-input");

    // Type something different — button should appear
    apiKeyInput.value = "sk-something-else";
    apiKeyInput.dispatchEvent(new Event("input"));
    expect(saveBtn.hidden).toBe(false);

    // Restore to stored key — button should hide
    apiKeyInput.value = storedKey;
    apiKeyInput.dispatchEvent(new Event("input"));
    expect(saveBtn.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Save flow — type new key → button visible → click Save → button hidden
  // Requirements: 3.1
  // -------------------------------------------------------------------------
  test("clicking Save hides the button after a successful save", async () => {
    const storedKey = "sk-old-key";
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) =>
      cb({ openrouterApiKey: storedKey })
    );
    mockStorageSessionSet.mockImplementation((_data, cb) => cb && cb());

    await initPopup();

    const saveBtn = document.getElementById("save-api-key-btn");
    const apiKeyInput = document.getElementById("api-key-input");

    // Type a new key — button should appear
    apiKeyInput.value = "sk-brand-new-key";
    apiKeyInput.dispatchEvent(new Event("input"));
    expect(saveBtn.hidden).toBe(false);

    // Click Save
    saveBtn.click();

    // Button should now be hidden
    expect(saveBtn.hidden).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 6. Smoke: input attributes preserved
  // Requirements: 4.1
  // -------------------------------------------------------------------------
  test("#api-key-input has type='password' and autocomplete='off'", async () => {
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) => cb({}));

    await initPopup();

    const apiKeyInput = document.getElementById("api-key-input");

    expect(apiKeyInput.getAttribute("type")).toBe("password");
    expect(apiKeyInput.getAttribute("autocomplete")).toBe("off");
  });

  // -------------------------------------------------------------------------
  // 7. Smoke: settings panel structure — details and summary elements exist
  // Requirements: 4.2
  // -------------------------------------------------------------------------
  test("settings panel contains <details> and <summary> elements", async () => {
    mockStorageLocalGet.mockImplementation((_keys, cb) => cb({}));
    mockStorageSessionGet.mockImplementation((_keys, cb) => cb({}));

    await initPopup();

    const settingsPanel = document.getElementById("settings-panel");
    const details = settingsPanel.querySelector("details");
    const summary = settingsPanel.querySelector("summary");

    expect(details).not.toBeNull();
    expect(summary).not.toBeNull();
  });
});
