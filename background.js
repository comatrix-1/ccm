/**
 * @fileoverview Background service worker for the Course Content Monitor extension.
 * Coordinates the full check pipeline: DOM extraction, link checking, semantic analysis,
 * and fix suggestion generation. All network I/O runs here.
 */

import { countTokens } from './src/tokenizer.js';
import { checkLinks } from './src/linkChecker.js';
import { runSemanticCheck } from './src/semanticChecker.js';
import { generateBrokenLinkSuggestion, generateOutdatedSectionSuggestion } from './src/fixSuggestions.js';

// ---------------------------------------------------------------------------
// truncateToTokenLimit
// ---------------------------------------------------------------------------

/**
 * Truncates text so that its token count (cl100k_base) is at or below maxTokens.
 * Uses a binary search over character positions for efficiency.
 *
 * @param {string} text
 * @param {number} [maxTokens=12000]
 * @returns {string}
 */
export function truncateToTokenLimit(text, maxTokens = 12_000) {
  if (text === '') return '';
  if (countTokens(text) <= maxTokens) return text;

  // Binary search over character length to find the longest prefix within the token limit.
  let lo = 0;
  let hi = text.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const slice = text.slice(0, mid);
    if (countTokens(slice) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return text.slice(0, lo);
}

// ---------------------------------------------------------------------------
// handleStartCheck — orchestration
// ---------------------------------------------------------------------------

/**
 * Writes a CheckState to chrome.storage.local under the key "checkState".
 * @param {import('./src/types.js').CheckState} state
 * @returns {Promise<void>}
 */
async function writeCheckState(state) {
  await chrome.storage.local.set({ checkState: state });
}

/**
 * Entry point: handles the START_CHECK message from the popup.
 * Coordinates the full pipeline and writes progress/result to chrome.storage.local.
 *
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<void>}
 */
export async function handleStartCheck(sender) {
  console.log('handleStartCheck()')

  // sender.tab is only populated when the message comes from a content script.
  // When the message comes from the popup, sender.tab is undefined, so we fall
  // back to querying the active tab in the current window.
  let tabId = sender?.tab?.id ?? null;

  console.log('tabId', tabId);

  if (tabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id ?? null;
  }

  console.log('tabId 2', tabId);

  // Guard: cannot check non-tab contexts (e.g. chrome:// pages where content script is absent)
  if (tabId == null) {
    await writeCheckState({
      status: 'complete',
      result: {
        pageUrl: '',
        pageTitle: '',
        brokenLinks: [],
        outdatedSections: [],
        fixSuggestions: [],
        checkedAt: new Date().toISOString(),
        semanticCheckError: 'Cannot check this page type.',
        linkResults: null,
        semanticCoverage: null,
      },
    });
    return;
  }

  console.log('extracting')

  // Phase 1: extracting
  await writeCheckState({
    status: 'in_progress',
    phase: 'extracting',
    startedAt: Date.now(),
  });

  // Request page data from the content script
  let pageData;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE_DATA' });

    console.log('response', response);

    if (!response || response.type === 'EXTRACT_ERROR') {
      const errMsg = response?.error ?? 'Could not extract page content.';
      // Check if this is a chrome:// page (content script not injected)
      const isPageTypeError =
        errMsg.includes('Cannot check this page type') ||
        errMsg.includes('chrome://') ||
        errMsg.includes('Cannot access');
      await writeCheckState({
        status: 'complete',
        result: {
          pageUrl: '',
          pageTitle: '',
          brokenLinks: [],
          outdatedSections: [],
          fixSuggestions: [],
          checkedAt: new Date().toISOString(),
          semanticCheckError: isPageTypeError ? 'Cannot check this page type.' : errMsg,
          linkResults: null,
          semanticCoverage: null,
        },
      });
      return;
    }

    pageData = response.payload;
  } catch (err) {
    // chrome.tabs.sendMessage throws when the content script is not present
    // (e.g. chrome:// pages, extension pages, etc.)
    const message = err?.message ?? String(err);
    console.log('error message: ', message)
    const isPageTypeError =
      message.includes('Could not establish connection') ||
      message.includes('No tab with id') ||
      message.includes('Cannot access') ||
      message.includes('chrome://');
    await writeCheckState({
      status: 'complete',
      result: {
        pageUrl: '',
        pageTitle: '',
        brokenLinks: [],
        outdatedSections: [],
        fixSuggestions: [],
        checkedAt: new Date().toISOString(),
        semanticCheckError: isPageTypeError ? 'Cannot check this page type.' : message,
        linkResults: null,
        semanticCoverage: null,
      },
    });
    return;
  }

  console.log('pageData: ', pageData)
  const { links, textContent, pageUrl, pageTitle } = pageData;

  // Phase 2: checking_links
  console.log('checking links')
  const allLinks = links ?? [];
  await writeCheckState({
    status: 'in_progress',
    phase: 'checking_links',
    startedAt: Date.now(),
    linksChecked: 0,
    totalLinks: allLinks.length,
  });

  // Build a Map<url, anchorText> for O(1) lookup when constructing LinkResult[]
  const anchorTextMap = new Map(allLinks.map((l) => [l.url, l.anchorText]));

  const linkCheckResults = await checkLinks(allLinks);

  /** @type {import('./src/types.js').LinkResult[]} */
  const linkResults = linkCheckResults.map((r) => {
    if (r.status === 'ok') {
      const entry = {
        status: 'ok',
        url: r.url,
        anchorText: anchorTextMap.get(r.url) ?? '',
      };
      if (typeof r.statusCode === 'number') {
        entry.statusCode = r.statusCode;
      }
      if (typeof r.attemptCount === 'number') entry.attemptCount = r.attemptCount;
      if (typeof r.soft404Result === 'string') entry.soft404Result = r.soft404Result;
      return entry;
    }
    // broken
    const brokenEntry = {
      status: 'broken',
      url: r.link.url,
      anchorText: r.link.anchorText,
      reason: r.link.reason,
    };
    if (typeof r.attemptCount === 'number') brokenEntry.attemptCount = r.attemptCount;
    if (typeof r.soft404Result === 'string') brokenEntry.soft404Result = r.soft404Result;
    return brokenEntry;
  });

  /** @type {import('./src/types.js').BrokenLink[]} */
  const brokenLinks = linkCheckResults
    .filter((r) => r.status === 'broken')
    .map((r) => /** @type {import('./src/types.js').LinkCheckResultBroken} */ (r).link);

  // Phase 3: semantic_check
  await writeCheckState({
    status: 'in_progress',
    phase: 'semantic_check',
    startedAt: Date.now(),
  });

  const truncatedText = truncateToTokenLimit(textContent ?? '');
  /** @type {import('./src/types.js').SemanticCoverage} */
  const semanticCoverage = {
    submittedCharCount: truncatedText.length,
    totalCharCount: (textContent ?? '').length,
  };
  const semanticResult = await runSemanticCheck(truncatedText);

  // Generate fix suggestions for all broken links and outdated sections
  const brokenLinkSuggestions = await Promise.all(
    brokenLinks.map((link) => generateBrokenLinkSuggestion(link)),
  );
  const outdatedSectionSuggestions = (semanticResult.outdatedSections ?? []).map(
    (section) => generateOutdatedSectionSuggestion(section),
  );

  /** @type {import('./src/types.js').CheckResult} */
  const result = {
    pageUrl,
    pageTitle,
    brokenLinks,
    outdatedSections: semanticResult.outdatedSections ?? [],
    fixSuggestions: [...brokenLinkSuggestions, ...outdatedSectionSuggestions],
    checkedAt: new Date().toISOString(),
    linkResults,
    semanticCoverage,
  };

  if (semanticResult.semanticCheckError) {
    result.semanticCheckError = semanticResult.semanticCheckError;
  }

  // Phase 4: complete
  await writeCheckState({ status: 'complete', result });
}

// ---------------------------------------------------------------------------
// handleStartLinkCheck — link-only orchestration
// ---------------------------------------------------------------------------

/**
 * Entry point: handles the START_LINK_CHECK message from the popup.
 * Runs only the extraction and link-checking phases.
 *
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<void>}
 */
export async function handleStartLinkCheck(sender) {
  let tabId = sender?.tab?.id ?? null;

  if (tabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id ?? null;
  }

  if (tabId == null) {
    await writeCheckState({
      status: 'complete',
      result: {
        pageUrl: '',
        pageTitle: '',
        brokenLinks: [],
        outdatedSections: [],
        fixSuggestions: [],
        checkedAt: new Date().toISOString(),
        semanticCheckError: 'Cannot check this page type.',
        linkResults: null,
        semanticCoverage: null,
      },
    });
    return;
  }

  // Phase 1: extracting
  await writeCheckState({
    status: 'in_progress',
    phase: 'extracting',
    startedAt: Date.now(),
  });

  let pageData;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE_DATA' });

    if (!response || response.type === 'EXTRACT_ERROR') {
      const errMsg = response?.error ?? 'Could not extract page content.';
      const isPageTypeError =
        errMsg.includes('Cannot check this page type') ||
        errMsg.includes('chrome://') ||
        errMsg.includes('Cannot access');
      await writeCheckState({
        status: 'complete',
        result: {
          pageUrl: '',
          pageTitle: '',
          brokenLinks: [],
          outdatedSections: [],
          fixSuggestions: [],
          checkedAt: new Date().toISOString(),
          semanticCheckError: isPageTypeError ? 'Cannot check this page type.' : errMsg,
          linkResults: null,
          semanticCoverage: null,
        },
      });
      return;
    }

    pageData = response.payload;
  } catch (err) {
    const message = err?.message ?? String(err);
    const isPageTypeError =
      message.includes('Could not establish connection') ||
      message.includes('No tab with id') ||
      message.includes('Cannot access') ||
      message.includes('chrome://');
    await writeCheckState({
      status: 'complete',
      result: {
        pageUrl: '',
        pageTitle: '',
        brokenLinks: [],
        outdatedSections: [],
        fixSuggestions: [],
        checkedAt: new Date().toISOString(),
        semanticCheckError: isPageTypeError ? 'Cannot check this page type.' : message,
        linkResults: null,
        semanticCoverage: null,
      },
    });
    return;
  }

  const { links, pageUrl, pageTitle } = pageData;

  // Phase 2: checking_links
  const allLinks = links ?? [];
  await writeCheckState({
    status: 'in_progress',
    phase: 'checking_links',
    startedAt: Date.now(),
    linksChecked: 0,
    totalLinks: allLinks.length,
  });

  // Build a Map<url, anchorText> for O(1) lookup when constructing LinkResult[]
  const anchorTextMap = new Map(allLinks.map((l) => [l.url, l.anchorText]));

  const linkCheckResults = await checkLinks(allLinks);

  /** @type {import('./src/types.js').LinkResult[]} */
  const linkResults = linkCheckResults.map((r) => {
    if (r.status === 'ok') {
      const entry = {
        status: 'ok',
        url: r.url,
        anchorText: anchorTextMap.get(r.url) ?? '',
      };
      if (typeof r.statusCode === 'number') {
        entry.statusCode = r.statusCode;
      }
      if (typeof r.attemptCount === 'number') entry.attemptCount = r.attemptCount;
      if (typeof r.soft404Result === 'string') entry.soft404Result = r.soft404Result;
      return entry;
    }
    // broken
    const brokenEntry = {
      status: 'broken',
      url: r.link.url,
      anchorText: r.link.anchorText,
      reason: r.link.reason,
    };
    if (typeof r.attemptCount === 'number') brokenEntry.attemptCount = r.attemptCount;
    if (typeof r.soft404Result === 'string') brokenEntry.soft404Result = r.soft404Result;
    return brokenEntry;
  });

  /** @type {import('./src/types.js').BrokenLink[]} */
  const brokenLinks = linkCheckResults
    .filter((r) => r.status === 'broken')
    .map((r) => /** @type {import('./src/types.js').LinkCheckResultBroken} */ (r).link);

  // Generate fix suggestions for broken links only
  const brokenLinkSuggestions = await Promise.all(
    brokenLinks.map((link) => generateBrokenLinkSuggestion(link)),
  );

  /** @type {import('./src/types.js').CheckResult} */
  const result = {
    pageUrl,
    pageTitle,
    brokenLinks,
    outdatedSections: [],
    fixSuggestions: [...brokenLinkSuggestions],
    checkedAt: new Date().toISOString(),
    linkResults,
    semanticCoverage: null,
  };

  await writeCheckState({ status: 'complete', result });
}

// ---------------------------------------------------------------------------
// handleStartSemanticCheck — semantic-only orchestration
// ---------------------------------------------------------------------------

/**
 * Entry point: handles the START_SEMANTIC_CHECK message from the popup.
 * Runs only the extraction and semantic-check phases.
 *
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<void>}
 */
export async function handleStartSemanticCheck(sender) {
  let tabId = sender?.tab?.id ?? null;

  if (tabId == null) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id ?? null;
  }

  if (tabId == null) {
    await writeCheckState({
      status: 'complete',
      result: {
        pageUrl: '',
        pageTitle: '',
        brokenLinks: [],
        outdatedSections: [],
        fixSuggestions: [],
        checkedAt: new Date().toISOString(),
        semanticCheckError: 'Cannot check this page type.',
        linkResults: null,
        semanticCoverage: null,
      },
    });
    return;
  }

  // Phase 1: extracting
  await writeCheckState({
    status: 'in_progress',
    phase: 'extracting',
    startedAt: Date.now(),
  });

  let pageData;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE_DATA' });

    if (!response || response.type === 'EXTRACT_ERROR') {
      const errMsg = response?.error ?? 'Could not extract page content.';
      const isPageTypeError =
        errMsg.includes('Cannot check this page type') ||
        errMsg.includes('chrome://') ||
        errMsg.includes('Cannot access');
      await writeCheckState({
        status: 'complete',
        result: {
          pageUrl: '',
          pageTitle: '',
          brokenLinks: [],
          outdatedSections: [],
          fixSuggestions: [],
          checkedAt: new Date().toISOString(),
          semanticCheckError: isPageTypeError ? 'Cannot check this page type.' : errMsg,
          linkResults: null,
          semanticCoverage: null,
        },
      });
      return;
    }

    pageData = response.payload;
  } catch (err) {
    const message = err?.message ?? String(err);
    const isPageTypeError =
      message.includes('Could not establish connection') ||
      message.includes('No tab with id') ||
      message.includes('Cannot access') ||
      message.includes('chrome://');
    await writeCheckState({
      status: 'complete',
      result: {
        pageUrl: '',
        pageTitle: '',
        brokenLinks: [],
        outdatedSections: [],
        fixSuggestions: [],
        checkedAt: new Date().toISOString(),
        semanticCheckError: isPageTypeError ? 'Cannot check this page type.' : message,
        linkResults: null,
        semanticCoverage: null,
      },
    });
    return;
  }

  const { textContent, pageUrl, pageTitle } = pageData;

  // Phase 3: semantic_check
  await writeCheckState({
    status: 'in_progress',
    phase: 'semantic_check',
    startedAt: Date.now(),
  });

  const truncatedText = truncateToTokenLimit(textContent ?? '');
  /** @type {import('./src/types.js').SemanticCoverage} */
  const semanticCoverage = {
    submittedCharCount: truncatedText.length,
    totalCharCount: (textContent ?? '').length,
  };
  const semanticResult = await runSemanticCheck(truncatedText);

  // Generate fix suggestions for outdated sections only
  const outdatedSectionSuggestions = (semanticResult.outdatedSections ?? []).map(
    (section) => generateOutdatedSectionSuggestion(section),
  );

  /** @type {import('./src/types.js').CheckResult} */
  const result = {
    pageUrl,
    pageTitle,
    brokenLinks: [],
    outdatedSections: semanticResult.outdatedSections ?? [],
    fixSuggestions: [...outdatedSectionSuggestions],
    checkedAt: new Date().toISOString(),
    linkResults: null,
    semanticCoverage,
  };

  if (semanticResult.semanticCheckError) {
    result.semanticCheckError = semanticResult.semanticCheckError;
  }

  await writeCheckState({ status: 'complete', result });
}

// ---------------------------------------------------------------------------
// Message listener registration
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'START_CHECK') {
    handleStartCheck(sender);
    // Return false — we don't use sendResponse for this message type.
    return false;
  }

  if (message?.type === 'START_LINK_CHECK') {
    handleStartLinkCheck(sender);
    return false;
  }

  if (message?.type === 'START_SEMANTIC_CHECK') {
    handleStartSemanticCheck(sender);
    return false;
  }

  if (message?.type === 'CANCEL_CHECK') {
    // v1 stub — cancellation is not implemented; the check continues to completion.
    return false;
  }

  return false;
});
