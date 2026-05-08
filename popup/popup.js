/**
 * Translates a CheckState (read from chrome.storage.local) into a PopupState
 * suitable for rendering. This is the sole place where stale in_progress detection
 * (the 60-second threshold) is applied.
 *
 * @param {import('../src/types.js').CheckState | undefined} state - value read from storage; undefined treated as idle
 * @param {number} now - current timestamp in ms (Date.now()); injected for testability
 * @returns {import('../src/types.js').PopupState}
 */
export function checkStateToPopupState(state, now) {
  // undefined or idle → idle
  if (state === undefined || state === null || state.status === "idle") {
    return { status: "idle" };
  }

  if (state.status === "in_progress") {
    const elapsed = now - state.startedAt;
    if (elapsed >= 60_000) {
      // Stale in_progress — the worker was likely interrupted
      return {
        status: "error",
        message: "Check was interrupted — run again?",
      };
    }
    // Active in_progress — show loading with current phase
    return {
      status: "loading",
      progress: { phase: state.phase },
    };
  }

  if (state.status === "complete") {
    return {
      status: "complete",
      result: state.result,
    };
  }

  // Fallback for any unrecognised state
  return { status: "idle" };
}

// ---------------------------------------------------------------------------
// resolveCheckMode — maps checkbox state to message type
// ---------------------------------------------------------------------------

/**
 * Resolves the message type to send based on checkbox state.
 * @param {boolean} linksChecked
 * @param {boolean} semanticChecked
 * @returns {"START_CHECK" | "START_LINK_CHECK" | "START_SEMANTIC_CHECK" | null}
 */
export function resolveCheckMode(linksChecked, semanticChecked) {
  if (linksChecked && semanticChecked) return "START_CHECK";
  if (linksChecked) return "START_LINK_CHECK";
  if (semanticChecked) return "START_SEMANTIC_CHECK";
  return null;
}

// ---------------------------------------------------------------------------
// Phase label mapping
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const PHASE_LABELS = {
  extracting: "Extracting page data…",
  checking_links: "Checking links…",
  semantic_check: "Running semantic check…",
  done: "Finishing up…",
};

/**
 * Returns a human-readable label for a progress phase.
 * @param {string | undefined} phase
 * @returns {string}
 */
function phaseLabel(phase) {
  return (phase && PHASE_LABELS[phase]) || "Checking…";
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Shows one view and hides all others.
 * @param {"idle" | "loading" | "complete" | "error"} viewName
 */
function showView(viewName) {
  const views = ["idle", "loading", "complete", "error", "report"];
  for (const name of views) {
    const el = document.getElementById(`${name}-view`);
    if (el) {
      el.hidden = name !== viewName;
    }
  }
}

/**
 * Renders a single broken link as an <li> element.
 * @param {import('../src/types.js').BrokenLink} link
 * @returns {HTMLLIElement}
 */
function renderBrokenLinkItem(link) {
  const li = document.createElement("li");
  li.className = "result-item result-item--high";

  const header = document.createElement("div");
  header.className = "result-item__header";

  const location = document.createElement("span");
  location.className = "result-item__location";
  location.textContent = link.anchorText || link.url;

  const severityBadge = document.createElement("span");
  severityBadge.className = "result-item__severity result-item__severity--high";
  severityBadge.textContent = "High";

  header.appendChild(location);
  header.appendChild(severityBadge);

  const description = document.createElement("p");
  description.className = "result-item__description";
  description.textContent = `Link is broken: ${link.reason.type}.`;

  const urlEl = document.createElement("span");
  urlEl.className = "result-item__url";
  urlEl.textContent = link.url;

  li.appendChild(header);
  li.appendChild(description);
  li.appendChild(urlEl);

  return li;
}

/**
 * Renders a single outdated section as an <li> element.
 * @param {import('../src/types.js').OutdatedSection} section
 * @returns {HTMLLIElement}
 */
function renderOutdatedSectionItem(section) {
  const li = document.createElement("li");
  li.className = `result-item result-item--${section.severity}`;

  const header = document.createElement("div");
  header.className = "result-item__header";

  const location = document.createElement("span");
  location.className = "result-item__location";
  location.textContent =
    section.sectionText.length > 80
      ? section.sectionText.slice(0, 80) + "…"
      : section.sectionText;

  const severityBadge = document.createElement("span");
  severityBadge.className = `result-item__severity result-item__severity--${section.severity}`;
  severityBadge.textContent =
    section.severity.charAt(0).toUpperCase() + section.severity.slice(1);

  header.appendChild(location);
  header.appendChild(severityBadge);

  const description = document.createElement("p");
  description.className = "result-item__description";
  description.textContent = section.reason;

  li.appendChild(header);
  li.appendChild(description);

  return li;
}

/**
 * Renders a diagnostic detail row with chips for statusCode, attemptCount, and soft404Result.
 * Returns null when no chips are present (all fields absent or soft404Result is "not_checked").
 * @param {import('../src/types.js').LinkResult} linkResult
 * @returns {HTMLDivElement | null}
 */
function renderDiagnosticDetail(linkResult) {
  const detail = document.createElement('div');
  detail.className = 'link-result__detail';

  // HTTP status chip
  if (linkResult.statusCode != null) {
    const chip = document.createElement('span');
    chip.className = 'link-detail__chip link-detail__chip--status';
    chip.textContent = `HTTP ${linkResult.statusCode}`;
    chip.setAttribute('aria-label', `HTTP status ${linkResult.statusCode}`);
    detail.appendChild(chip);
  }

  // Attempt count chip
  if (linkResult.attemptCount != null) {
    const chip = document.createElement('span');
    chip.className = 'link-detail__chip link-detail__chip--attempts';
    const label = linkResult.attemptCount === 1 ? '1 attempt' : `${linkResult.attemptCount} attempts`;
    chip.textContent = label;
    chip.setAttribute('aria-label', `${linkResult.attemptCount} attempt${linkResult.attemptCount === 1 ? '' : 's'} made`);
    detail.appendChild(chip);
  }

  // Soft-404 chip
  if (linkResult.soft404Result === 'passed') {
    const chip = document.createElement('span');
    chip.className = 'link-detail__chip link-detail__chip--soft404-passed';
    chip.textContent = 'soft-404: OK';
    chip.setAttribute('aria-label', 'soft-404 check passed');
    detail.appendChild(chip);
  } else if (linkResult.soft404Result === 'triggered') {
    const chip = document.createElement('span');
    chip.className = 'link-detail__chip link-detail__chip--soft404-triggered';
    chip.textContent = 'soft-404: triggered';
    chip.setAttribute('aria-label', 'soft-404 check triggered');
    detail.appendChild(chip);
  }

  return detail.children.length > 0 ? detail : null;
}

/**
 * Renders a single LinkResult as an <li> element.
 * @param {import('../src/types.js').LinkResult} linkResult
 * @returns {HTMLLIElement}
 */
function renderLinkResultItem(linkResult) {
  const li = document.createElement("li");
  li.className = `result-item link-result--${linkResult.status}`;

  const header = document.createElement("div");
  header.className = "result-item__header";

  const location = document.createElement("span");
  location.className = "result-item__location";
  location.textContent = linkResult.anchorText || linkResult.url;

  const statusBadge = document.createElement("span");
  statusBadge.className = `result-item__severity link-result__status link-result__status--${linkResult.status}`;

  if (linkResult.status === "ok") {
    statusBadge.textContent = linkResult.statusCode != null ? `OK · ${linkResult.statusCode}` : "OK";
    statusBadge.setAttribute(
      "aria-label",
      linkResult.statusCode != null ? `HTTP status ${linkResult.statusCode}` : "OK"
    );
  } else {
    statusBadge.textContent = "Broken";
    statusBadge.setAttribute("aria-label", `Broken: ${linkResult.reason.type}`);
  }

  header.appendChild(location);
  header.appendChild(statusBadge);

  li.appendChild(header);

  const detail = renderDiagnosticDetail(linkResult);
  if (detail) li.appendChild(detail);

  if (linkResult.status === "broken") {
    const description = document.createElement("p");
    description.className = "result-item__description";
    let descText = linkResult.reason.type;
    if (linkResult.reason.type === "http_error") {
      descText += ` (${linkResult.reason.statusCode})`;
    }
    description.textContent = descText;
    li.appendChild(description);
  }

  const urlEl = document.createElement("span");
  urlEl.className = "result-item__url";
  urlEl.textContent = linkResult.url;
  li.appendChild(urlEl);

  return li;
}

/**
 * Renders the Report_View from a CheckResult.
 * Exported for testability.
 * @param {import('../src/types.js').CheckResult} result
 */
export function renderReportView(result) {
  // Populate metadata
  const pageUrlEl = document.getElementById("report-page-url");
  if (pageUrlEl) pageUrlEl.textContent = result.pageUrl ?? "";

  const checkedAtEl = document.getElementById("report-checked-at");
  if (checkedAtEl) {
    checkedAtEl.textContent = result.checkedAt
      ? new Date(result.checkedAt).toLocaleString()
      : "";
  }

  // Handle linkResults (treat undefined as null)
  const linkResults = result.linkResults ?? null;
  const linksSection = document.getElementById("report-links-section");
  const noLinksMsg = document.getElementById("report-no-links-msg");
  const linksList = document.getElementById("report-links-list");

  if (linksSection) {
    if (linkResults === null) {
      linksSection.hidden = true;
    } else {
      linksSection.hidden = false;
      if (linkResults.length === 0) {
        if (noLinksMsg) noLinksMsg.hidden = false;
        if (linksList) linksList.hidden = true;
      } else {
        if (noLinksMsg) noLinksMsg.hidden = true;
        if (linksList) {
          linksList.hidden = false;
          linksList.innerHTML = "";
          for (const lr of linkResults) {
            linksList.appendChild(renderLinkResultItem(lr));
          }
        }
      }
    }
  }

  // Handle semanticCoverage (treat undefined as null)
  const semanticCoverage = result.semanticCoverage ?? null;
  const semanticSection = document.getElementById("report-semantic-section");
  const coverageEl = document.getElementById("report-coverage");
  const truncationNotice = document.getElementById("report-truncation-notice");
  const semanticErrorEl = document.getElementById("report-semantic-error");
  const noOutdatedMsg = document.getElementById("report-no-outdated-msg");
  const outdatedList = document.getElementById("report-outdated-list");

  if (semanticSection) {
    if (semanticCoverage === null) {
      semanticSection.hidden = true;
    } else {
      semanticSection.hidden = false;

      // Coverage counts
      if (coverageEl) {
        coverageEl.textContent = `${semanticCoverage.submittedCharCount.toLocaleString()} / ${semanticCoverage.totalCharCount.toLocaleString()} characters analysed`;
      }

      // Truncation notice
      if (truncationNotice) {
        truncationNotice.hidden =
          semanticCoverage.submittedCharCount >= semanticCoverage.totalCharCount;
      }

      // Semantic error
      if (semanticErrorEl) {
        if (result.semanticCheckError) {
          semanticErrorEl.textContent = result.semanticCheckError;
          semanticErrorEl.hidden = false;
        } else {
          semanticErrorEl.textContent = "";
          semanticErrorEl.hidden = true;
        }
      }

      // Outdated sections
      const outdatedSections = result.outdatedSections ?? [];
      if (outdatedList) {
        outdatedList.innerHTML = "";
        if (outdatedSections.length > 0) {
          if (noOutdatedMsg) noOutdatedMsg.hidden = true;
          outdatedList.hidden = false;
          for (const section of outdatedSections) {
            // Reuse renderOutdatedSectionItem but with 120-char truncation
            const li = document.createElement("li");
            li.className = `result-item result-item--${section.severity}`;

            const header = document.createElement("div");
            header.className = "result-item__header";

            const location = document.createElement("span");
            location.className = "result-item__location";
            location.textContent =
              section.sectionText.length > 120
                ? section.sectionText.slice(0, 120) + "…"
                : section.sectionText;

            const severityBadge = document.createElement("span");
            severityBadge.className = `result-item__severity result-item__severity--${section.severity}`;
            severityBadge.textContent =
              section.severity.charAt(0).toUpperCase() + section.severity.slice(1);

            header.appendChild(location);
            header.appendChild(severityBadge);

            const description = document.createElement("p");
            description.className = "result-item__description";
            description.textContent = section.reason;

            li.appendChild(header);
            li.appendChild(description);
            outdatedList.appendChild(li);
          }
        } else if (!result.semanticCheckError) {
          if (noOutdatedMsg) noOutdatedMsg.hidden = false;
          outdatedList.hidden = true;
        } else {
          if (noOutdatedMsg) noOutdatedMsg.hidden = true;
          outdatedList.hidden = true;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// renderPopup — main rendering function
// ---------------------------------------------------------------------------

/**
 * Updates the DOM to reflect the given PopupState.
 * @param {import('../src/types.js').PopupState} popupState
 */
export function renderPopup(popupState) {
  switch (popupState.status) {
    case "idle": {
      showView("idle");
      break;
    }

    case "loading": {
      showView("loading");
      const phaseEl = document.getElementById("loading-phase-label");
      if (phaseEl) {
        phaseEl.textContent = phaseLabel(popupState.progress?.phase);
      }
      break;
    }

    case "complete": {
      showView("complete");
      const result = popupState.result;

      // --- Error banner ---
      const errorBanner = document.getElementById("error-banner");
      if (errorBanner) {
        if (result.semanticCheckError !== undefined && result.semanticCheckError !== null) {
          const trimmedError = result.semanticCheckError.trim();
          errorBanner.textContent =
            trimmedError.length > 0
              ? trimmedError
              : "Semantic check encountered an error.";
          errorBanner.hidden = false;
        } else {
          errorBanner.textContent = "";
          errorBanner.hidden = true;
        }
      }

      // --- Severity summary counts ---
      const fixSuggestions = result.fixSuggestions || [];
      const highCount = fixSuggestions.filter((s) => s.severity === "high").length;
      const mediumCount = fixSuggestions.filter((s) => s.severity === "medium").length;
      const lowCount = fixSuggestions.filter((s) => s.severity === "low").length;

      const highEl = document.getElementById("summary-high");
      const mediumEl = document.getElementById("summary-medium");
      const lowEl = document.getElementById("summary-low");
      if (highEl) highEl.textContent = String(highCount);
      if (mediumEl) mediumEl.textContent = String(mediumCount);
      if (lowEl) lowEl.textContent = String(lowCount);

      // --- Broken links list ---
      const brokenLinksList = document.getElementById("broken-links-list");
      if (brokenLinksList) {
        brokenLinksList.innerHTML = "";
        for (const link of result.brokenLinks || []) {
          brokenLinksList.appendChild(renderBrokenLinkItem(link));
        }
      }

      // --- Semantic issues list ---
      const semanticIssuesList = document.getElementById("semantic-issues-list");
      if (semanticIssuesList) {
        semanticIssuesList.innerHTML = "";
        for (const section of result.outdatedSections || []) {
          semanticIssuesList.appendChild(renderOutdatedSectionItem(section));
        }
      }

      // --- Section visibility ---
      const brokenLinksSection = document.getElementById("broken-links-section");
      if (brokenLinksSection) {
        brokenLinksSection.hidden = (result.brokenLinks ?? []).length === 0;
      }

      const semanticIssuesSection = document.getElementById("semantic-issues-section");
      if (semanticIssuesSection) {
        semanticIssuesSection.hidden = (result.outdatedSections ?? []).length === 0;
      }

      // --- No problems message ---
      const noProblemsMsg = document.getElementById("no-problems-message");
      if (noProblemsMsg) {
        const hasProblems =
          (result.brokenLinks && result.brokenLinks.length > 0) ||
          (result.outdatedSections && result.outdatedSections.length > 0);
        noProblemsMsg.hidden = hasProblems;
      }

      break;
    }

    case "error": {
      showView("error");
      const errorMsgEl = document.getElementById("error-message");
      if (errorMsgEl) {
        errorMsgEl.textContent = popupState.message || "An unexpected error occurred.";
      }
      break;
    }

    default:
      showView("idle");
  }
}

// ---------------------------------------------------------------------------
// initPopup — reads storage, renders, subscribes to changes, wires up buttons
// ---------------------------------------------------------------------------

/** @type {import('../src/types.js').CheckResult | null} */
let lastKnownResult = null;

/**
 * Initialises the popup: reads checkState from storage, renders, and subscribes
 * to live storage changes. Also wires up the Run Check button and settings UI.
 *
 * Exported for testing.
 * @returns {Promise<void>}
 */
export async function initPopup() {
  // --- Read initial state from storage ---
  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(["checkState", "openrouterApiKey"], (items) => {
      resolve(items);
    });
  });

  let storedApiKey = stored.openrouterApiKey ?? '';

  // Populate API key input if stored
  const apiKeyInput = document.getElementById("api-key-input");
  if (apiKeyInput) {
    apiKeyInput.value = storedApiKey;
  }

  // Render initial state
  const popupState = checkStateToPopupState(stored.checkState, Date.now());
  renderPopup(popupState);

  // Track last known result for the report view
  if (popupState.status === "complete") {
    lastKnownResult = popupState.result;
  }

  // --- Subscribe to storage changes for live updates ---
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if ("checkState" in changes) {
      const newState = changes.checkState.newValue;
      const updatedPopupState = checkStateToPopupState(newState, Date.now());
      renderPopup(updatedPopupState);
      // Track last known result
      if (updatedPopupState.status === "complete") {
        lastKnownResult = updatedPopupState.result;
      }
      // If report view is currently shown, update it too
      const reportView = document.getElementById("report-view");
      if (reportView && !reportView.hidden && newState?.status === "complete") {
        renderReportView(newState.result);
      }
    }
  });

  // --- Wire up "View Report" button (complete view) ---
  const viewReportBtn = document.getElementById("view-report-btn");
  if (viewReportBtn) {
    viewReportBtn.addEventListener("click", () => {
      if (lastKnownResult) renderReportView(lastKnownResult);
      showView("report");
    });
  }

  // --- Wire up "Back" button (report view) ---
  const backBtn = document.getElementById("back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      showView("complete");
    });
  }

  // --- Wire up "Run Check" button (idle view) ---
  const runCheckBtn = document.getElementById("run-check-btn");
  const idleLinksCheckbox = document.getElementById("idle-check-links");
  const idleSemanticCheckbox = document.getElementById("idle-semantic-check");

  function syncIdleButtonState() {
    if (runCheckBtn) {
      runCheckBtn.disabled = resolveCheckMode(
        idleLinksCheckbox?.checked ?? true,
        idleSemanticCheckbox?.checked ?? true
      ) === null;
    }
  }

  if (idleLinksCheckbox) idleLinksCheckbox.addEventListener("change", syncIdleButtonState);
  if (idleSemanticCheckbox) idleSemanticCheckbox.addEventListener("change", syncIdleButtonState);
  syncIdleButtonState();

  if (runCheckBtn) {
    runCheckBtn.addEventListener("click", () => {
      const mode = resolveCheckMode(
        idleLinksCheckbox?.checked ?? true,
        idleSemanticCheckbox?.checked ?? true
      );
      if (mode) chrome.runtime.sendMessage({ type: mode });
    });
  }

  // --- Wire up "Run Again" button (complete view) ---
  const rerunCheckBtn = document.getElementById("rerun-check-btn");
  const completeLinksCheckbox = document.getElementById("complete-check-links");
  const completeSemanticCheckbox = document.getElementById("complete-semantic-check");

  function syncCompleteButtonState() {
    if (rerunCheckBtn) {
      rerunCheckBtn.disabled = resolveCheckMode(
        completeLinksCheckbox?.checked ?? true,
        completeSemanticCheckbox?.checked ?? true
      ) === null;
    }
  }

  if (completeLinksCheckbox) completeLinksCheckbox.addEventListener("change", syncCompleteButtonState);
  if (completeSemanticCheckbox) completeSemanticCheckbox.addEventListener("change", syncCompleteButtonState);
  syncCompleteButtonState();

  if (rerunCheckBtn) {
    rerunCheckBtn.addEventListener("click", () => {
      const mode = resolveCheckMode(
        completeLinksCheckbox?.checked ?? true,
        completeSemanticCheckbox?.checked ?? true
      );
      if (mode) chrome.runtime.sendMessage({ type: mode });
    });
  }

  // --- Wire up "Try Again" button (error view) ---
  const retryCheckBtn = document.getElementById("retry-check-btn");
  const errorLinksCheckbox = document.getElementById("error-check-links");
  const errorSemanticCheckbox = document.getElementById("error-semantic-check");

  function syncErrorButtonState() {
    if (retryCheckBtn) {
      retryCheckBtn.disabled = resolveCheckMode(
        errorLinksCheckbox?.checked ?? true,
        errorSemanticCheckbox?.checked ?? true
      ) === null;
    }
  }

  if (errorLinksCheckbox) errorLinksCheckbox.addEventListener("change", syncErrorButtonState);
  if (errorSemanticCheckbox) errorSemanticCheckbox.addEventListener("change", syncErrorButtonState);
  syncErrorButtonState();

  if (retryCheckBtn) {
    retryCheckBtn.addEventListener("click", () => {
      const mode = resolveCheckMode(
        errorLinksCheckbox?.checked ?? true,
        errorSemanticCheckbox?.checked ?? true
      );
      if (mode) chrome.runtime.sendMessage({ type: mode });
    });
  }

  // --- Wire up settings: save API key ---
  const saveApiKeyBtn = document.getElementById("save-api-key-btn");

  function updateSaveButtonVisibility() {
    if (saveApiKeyBtn) {
      saveApiKeyBtn.hidden = apiKeyInput.value.trim() === (storedApiKey ?? '');
    }
  }

  // Set correct initial state
  updateSaveButtonVisibility();

  if (apiKeyInput) {
    apiKeyInput.addEventListener('input', updateSaveButtonVisibility);
  }

  if (saveApiKeyBtn && apiKeyInput) {
    saveApiKeyBtn.addEventListener("click", () => {
      // Strip newlines and surrounding whitespace — stray newlines cause Chrome
      // to silently drop the Authorization header when the key is used in fetch().
      const key = apiKeyInput.value.replace(/[\r\n]/g, '').trim();
      chrome.storage.local.set({ openrouterApiKey: key }, () => {
        storedApiKey = key;
        updateSaveButtonVisibility();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap — only runs in a real browser context (not during tests)
// ---------------------------------------------------------------------------

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    initPopup();
  });
}
