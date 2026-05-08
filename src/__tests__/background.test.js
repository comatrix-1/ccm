import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock chrome APIs before importing the module under test.
// vi.stubGlobal must run before the dynamic import of background.js.
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
// Mock the dependency modules that background.js imports.
// vi.mock is hoisted to the top of the file by Vitest, so these run before
// any imports — including the dynamic import of background.js below.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Import the module under test and its mocked dependencies.
// Dynamic imports ensure chrome globals and vi.mock are in place first.
// ---------------------------------------------------------------------------
const { truncateToTokenLimit, handleStartCheck, handleStartLinkCheck, handleStartSemanticCheck } = await import('../../background.js');
const { checkLinks } = await import('../../src/linkChecker.js');
const { runSemanticCheck } = await import('../../src/semanticChecker.js');
const { generateBrokenLinkSuggestion, generateOutdatedSectionSuggestion } = await import(
  '../../src/fixSuggestions.js'
);

// Capture the message listener registered at module load time (before clearAllMocks runs).
// background.js calls chrome.runtime.onMessage.addListener() as a side effect on import.
const registeredMessageListener = mockRuntimeOnMessageAddListener.mock.calls[0]?.[0];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all CheckState values written to storage in call order. */
function captureStorageWrites() {
  const states = [];
  mockStorageSet.mockImplementation(async (obj) => {
    if (obj.checkState !== undefined) {
      states.push(obj.checkState);
    }
  });
  return states;
}

/** Build a minimal successful PageData response from the content script. */
function makePageDataResponse(overrides = {}) {
  return {
    type: 'PAGE_DATA',
    payload: {
      links: [],
      textContent: 'Some page text content.',
      pageUrl: 'https://example.com/course',
      pageTitle: 'Example Course',
      ...overrides,
    },
  };
}

/** Build a sender object with a tab id. */
function makeSender(tabId = 1) {
  return { tab: { id: tabId } };
}

// ---------------------------------------------------------------------------
// Unit tests — truncateToTokenLimit()
// Validates: Requirements 2.1
// ---------------------------------------------------------------------------

describe('truncateToTokenLimit()', () => {
  test('empty string returns empty string', () => {
    expect(truncateToTokenLimit('', 100)).toBe('');
  });

  test('text already within maxTokens is returned unchanged', () => {
    const text = 'Hello world';
    const result = truncateToTokenLimit(text, 100);
    expect(result).toBe(text);
  });

  test('text exceeding maxTokens is truncated to a string whose token count <= maxTokens', async () => {
    const { countTokens } = await import('../../src/tokenizer.js');
    const longText = 'The quick brown fox jumps over the lazy dog. '.repeat(200);
    const maxTokens = 50;
    const result = truncateToTokenLimit(longText, maxTokens);
    expect(result.length).toBeLessThan(longText.length);
    expect(countTokens(result)).toBeLessThanOrEqual(maxTokens);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — handleStartCheck() orchestration
// Validates: Requirements 2.7, 4.5, 4.6
// ---------------------------------------------------------------------------

describe('handleStartCheck() orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no-op storage set
    mockStorageSet.mockResolvedValue(undefined);
    // Default: tabs.query returns the active tab with id 1
    mockTabsQuery.mockResolvedValue([{ id: 1 }]);
    // Default: successful semantic check with no issues
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });
    // Default: no fix suggestions
    generateBrokenLinkSuggestion.mockResolvedValue({
      problemType: 'broken_link',
      severity: 'high',
      location: 'some link',
      description: 'broken',
    });
    generateOutdatedSectionSuggestion.mockReturnValue({
      problemType: 'outdated_section',
      severity: 'medium',
      location: 'some section',
      description: 'outdated',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Test: EXTRACT_ERROR from content script writes error CheckState and does
  // not proceed to link check.
  // -------------------------------------------------------------------------
  test('EXTRACT_ERROR from content script writes error CheckState and does not proceed to link check', async () => {
    mockTabsSendMessage.mockResolvedValue({
      type: 'EXTRACT_ERROR',
      error: 'Could not extract page content.',
    });

    await handleStartCheck(makeSender(1));

    // checkLinks must NOT have been called
    expect(checkLinks).not.toHaveBeenCalled();

    // The final written state must be complete with a semanticCheckError
    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;
    expect(finalState.status).toBe('complete');
    expect(finalState.result.semanticCheckError).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Test: LLM failure still surfaces completed link check results in CheckResult.
  // -------------------------------------------------------------------------
  test('LLM failure still surfaces completed link check results in CheckResult', async () => {
    const brokenLink = {
      url: 'https://example.com/broken',
      anchorText: 'broken link',
      reason: { type: 'http_error', statusCode: 404 },
    };

    mockTabsSendMessage.mockResolvedValue(
      makePageDataResponse({
        links: [{ url: 'https://example.com/broken', anchorText: 'broken link', rawHref: '/broken' }],
      }),
    );
    checkLinks.mockResolvedValue([{ status: 'broken', link: brokenLink }]);
    runSemanticCheck.mockResolvedValue({
      outdatedSections: [],
      semanticCheckError: 'Semantic check timed out — re-run the check to try again.',
    });
    generateBrokenLinkSuggestion.mockResolvedValue({
      problemType: 'broken_link',
      severity: 'high',
      location: 'broken link',
      description: 'Link is broken: http_error. URL: https://example.com/broken',
    });

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;

    expect(finalState.status).toBe('complete');
    // Broken links are present despite LLM failure
    expect(finalState.result.brokenLinks).toHaveLength(1);
    expect(finalState.result.brokenLinks[0].url).toBe('https://example.com/broken');
    // semanticCheckError is set
    expect(finalState.result.semanticCheckError).toContain('timed out');
    // fixSuggestions includes the broken link suggestion
    expect(finalState.result.fixSuggestions).toHaveLength(1);
    expect(finalState.result.fixSuggestions[0].problemType).toBe('broken_link');
  });

  // -------------------------------------------------------------------------
  // Test: checkState transitions through extracting → checking_links →
  // semantic_check → complete in order.
  // -------------------------------------------------------------------------
  test('checkState transitions through extracting → checking_links → semantic_check → complete in order', async () => {
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse());
    checkLinks.mockResolvedValue([]);

    const phases = captureStorageWrites();

    await handleStartCheck(makeSender(1));

    const statuses = phases.map((s) => s.status);
    const inProgressPhases = phases
      .filter((s) => s.status === 'in_progress')
      .map((s) => s.phase);

    // Must have at least one in_progress write and one complete write
    expect(statuses).toContain('in_progress');
    expect(statuses[statuses.length - 1]).toBe('complete');

    // in_progress phases must appear in the correct order
    const extractingIdx = inProgressPhases.indexOf('extracting');
    const checkingLinksIdx = inProgressPhases.indexOf('checking_links');
    const semanticCheckIdx = inProgressPhases.indexOf('semantic_check');

    expect(extractingIdx).toBeGreaterThanOrEqual(0);
    expect(checkingLinksIdx).toBeGreaterThan(extractingIdx);
    expect(semanticCheckIdx).toBeGreaterThan(checkingLinksIdx);
  });

  // -------------------------------------------------------------------------
  // Test: CANCEL_CHECK message is ignored (check continues to completion).
  // The message listener is registered at module load time; sending CANCEL_CHECK
  // does nothing — no link check or semantic check is triggered.
  // -------------------------------------------------------------------------
  test('CANCEL_CHECK message is registered but ignored — no check is triggered', () => {
    // registeredMessageListener was captured at import time (before clearAllMocks).
    expect(registeredMessageListener).toBeDefined();

    // Simulate the registered listener receiving a CANCEL_CHECK message.
    // It should not throw and should not call checkLinks or runSemanticCheck.
    expect(() => registeredMessageListener({ type: 'CANCEL_CHECK' }, makeSender(1))).not.toThrow();
    expect(checkLinks).not.toHaveBeenCalled();
    expect(runSemanticCheck).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test: chrome:// page (content script not injected) writes
  // "Cannot check this page type." error.
  // -------------------------------------------------------------------------
  test('chrome:// page writes "Cannot check this page type." error', async () => {
    // Simulate the error thrown by chrome.tabs.sendMessage when the content
    // script is not present (e.g. on a chrome:// page).
    mockTabsSendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;

    expect(finalState.status).toBe('complete');
    expect(finalState.result.semanticCheckError).toBe('Cannot check this page type.');
    expect(checkLinks).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test: sender with no tab id (e.g. popup context) falls back to querying
  // the active tab and proceeds with the check.
  // -------------------------------------------------------------------------
  test('sender with no tab id falls back to active tab query and proceeds with the check', async () => {
    // tabs.query returns an active tab — the check should proceed normally
    mockTabsQuery.mockResolvedValue([{ id: 42 }]);
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse());
    checkLinks.mockResolvedValue([]);

    await handleStartCheck({ tab: null });

    // tabs.query must have been called to find the active tab
    expect(mockTabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });

    // The check should have proceeded: sendMessage called with the resolved tabId
    expect(mockTabsSendMessage).toHaveBeenCalledWith(42, { type: 'EXTRACT_PAGE_DATA' });

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;
    expect(finalState.status).toBe('complete');
    // No error — the check ran successfully
    expect(finalState.result.semanticCheckError).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Test: sender with no tab id and no active tab writes
  // "Cannot check this page type." error.
  // -------------------------------------------------------------------------
  test('sender with no tab id and no active tab writes "Cannot check this page type." error', async () => {
    mockTabsQuery.mockResolvedValue([]);

    await handleStartCheck({ tab: null });

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;

    expect(finalState.status).toBe('complete');
    expect(finalState.result.semanticCheckError).toBe('Cannot check this page type.');
    expect(checkLinks).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Task 2.1 — linkResults and semanticCoverage population
  // Validates: Requirements 1.1, 1.2, 2.1, 2.2
  // -------------------------------------------------------------------------

  test('full check with N links stores linkResults of length N with correct url/anchorText/status', async () => {
    const links = [
      { url: 'https://example.com/a', anchorText: 'Link A', rawHref: '/a' },
      { url: 'https://example.com/b', anchorText: 'Link B', rawHref: '/b' },
      { url: 'https://example.com/c', anchorText: 'Link C', rawHref: '/c' },
    ];
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ links }));
    checkLinks.mockResolvedValue([
      { status: 'ok', url: 'https://example.com/a' },
      { status: 'ok', url: 'https://example.com/b' },
      {
        status: 'broken',
        link: {
          url: 'https://example.com/c',
          anchorText: 'Link C',
          reason: { type: 'http_error', statusCode: 404 },
        },
      },
    ]);
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toHaveLength(3);

    // ok entries use anchorTextMap for anchorText
    expect(result.linkResults[0]).toEqual({ status: 'ok', url: 'https://example.com/a', anchorText: 'Link A' });
    expect(result.linkResults[1]).toEqual({ status: 'ok', url: 'https://example.com/b', anchorText: 'Link B' });

    // broken entry uses r.link fields
    expect(result.linkResults[2]).toEqual({
      status: 'broken',
      url: 'https://example.com/c',
      anchorText: 'Link C',
      reason: { type: 'http_error', statusCode: 404 },
    });
  });

  // -------------------------------------------------------------------------
  // Task 4.1 — statusCode propagation in handleStartCheck
  // Validates: Requirements 2.1, 2.2, 4.2
  // -------------------------------------------------------------------------

  test('handleStartCheck with LinkCheckResultOk carrying statusCode: 200 stores LinkResultOk with statusCode: 200', async () => {
    const links = [{ url: 'https://example.com/a', anchorText: 'Link A', rawHref: '/a' }];
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ links }));
    checkLinks.mockResolvedValue([
      { status: 'ok', url: 'https://example.com/a', statusCode: 200 },
    ]);
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults[0]).toEqual({
      status: 'ok',
      url: 'https://example.com/a',
      anchorText: 'Link A',
      statusCode: 200,
    });
  });

  test('handleStartCheck with LinkCheckResultOk without statusCode stores LinkResultOk without statusCode (not undefined, not NaN)', async () => {
    const links = [{ url: 'https://example.com/a', anchorText: 'Link A', rawHref: '/a' }];
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ links }));
    checkLinks.mockResolvedValue([
      { status: 'ok', url: 'https://example.com/a' },
    ]);
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults[0].statusCode).toBeUndefined();
    expect('statusCode' in result.linkResults[0]).toBe(false);
  });

  test('full check stores semanticCoverage with correct submittedCharCount and totalCharCount', async () => {
    const textContent = 'Hello world! This is some page text.';
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ textContent }));
    checkLinks.mockResolvedValue([]);
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.semanticCoverage).not.toBeNull();
    expect(result.semanticCoverage.totalCharCount).toBe(textContent.length);
    // Short text is not truncated, so submitted === total
    expect(result.semanticCoverage.submittedCharCount).toBe(textContent.length);
    expect(result.semanticCoverage.submittedCharCount).toBeLessThanOrEqual(result.semanticCoverage.totalCharCount);
  });

  test('extraction failure stores linkResults: null and semanticCoverage: null', async () => {
    mockTabsSendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toBeNull();
    expect(result.semanticCoverage).toBeNull();
  });

  test('page type error (no tab) stores linkResults: null and semanticCoverage: null', async () => {
    mockTabsQuery.mockResolvedValue([]);

    await handleStartCheck({ tab: null });

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toBeNull();
    expect(result.semanticCoverage).toBeNull();
  });

  test('EXTRACT_ERROR response stores linkResults: null and semanticCoverage: null', async () => {
    mockTabsSendMessage.mockResolvedValue({
      type: 'EXTRACT_ERROR',
      error: 'Could not extract page content.',
    });

    await handleStartCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toBeNull();
    expect(result.semanticCoverage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — handleStartLinkCheck() orchestration
// Validates: Requirements 4.1, 4.3
// ---------------------------------------------------------------------------

describe('handleStartLinkCheck() orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSet.mockResolvedValue(undefined);
    mockTabsQuery.mockResolvedValue([{ id: 1 }]);
    generateBrokenLinkSuggestion.mockResolvedValue({
      problemType: 'broken_link',
      severity: 'high',
      location: 'some link',
      description: 'broken',
    });
  });

  // -------------------------------------------------------------------------
  // Test: START_LINK_CHECK message invokes handleStartLinkCheck;
  // runSemanticCheck is NOT called.
  // -------------------------------------------------------------------------
  test('START_LINK_CHECK message invokes handleStartLinkCheck; runSemanticCheck is NOT called', async () => {
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse());
    checkLinks.mockResolvedValue([]);

    await handleStartLinkCheck(makeSender(1));

    expect(runSemanticCheck).not.toHaveBeenCalled();

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;
    expect(finalState.status).toBe('complete');
    expect(finalState.result.outdatedSections).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test: extraction failure writes semanticCheckError and does not call checkLinks.
  // -------------------------------------------------------------------------
  test('extraction failure writes semanticCheckError and does not call checkLinks', async () => {
    mockTabsSendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await handleStartLinkCheck(makeSender(1));

    expect(checkLinks).not.toHaveBeenCalled();

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;
    expect(finalState.status).toBe('complete');
    expect(finalState.result.semanticCheckError).toBe('Cannot check this page type.');
  });

  // -------------------------------------------------------------------------
  // Task 3.1 — linkResults and semanticCoverage population in handleStartLinkCheck
  // Validates: Requirements 1.1, 1.4, 2.4
  // -------------------------------------------------------------------------

  test('link-only check with 0 links stores linkResults: [] and semanticCoverage: null', async () => {
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ links: [] }));
    checkLinks.mockResolvedValue([]);

    await handleStartLinkCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toEqual([]);
    expect(result.semanticCoverage).toBeNull();
  });

  test('link-only check with broken links stores correct linkResults entries with reason', async () => {
    const links = [
      { url: 'https://example.com/ok', anchorText: 'OK Link', rawHref: '/ok' },
      { url: 'https://example.com/broken', anchorText: 'Broken Link', rawHref: '/broken' },
    ];
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ links }));
    checkLinks.mockResolvedValue([
      { status: 'ok', url: 'https://example.com/ok' },
      {
        status: 'broken',
        link: {
          url: 'https://example.com/broken',
          anchorText: 'Broken Link',
          reason: { type: 'http_error', statusCode: 404 },
        },
      },
    ]);

    await handleStartLinkCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toHaveLength(2);
    expect(result.linkResults[0]).toEqual({
      status: 'ok',
      url: 'https://example.com/ok',
      anchorText: 'OK Link',
    });
    expect(result.linkResults[1]).toEqual({
      status: 'broken',
      url: 'https://example.com/broken',
      anchorText: 'Broken Link',
      reason: { type: 'http_error', statusCode: 404 },
    });
    expect(result.semanticCoverage).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Task 4.1 — statusCode propagation in handleStartLinkCheck
  // Validates: Requirements 2.1, 2.2, 4.2
  // -------------------------------------------------------------------------

  test('handleStartLinkCheck with LinkCheckResultOk carrying statusCode: 429 stores LinkResultOk with statusCode: 429', async () => {
    const links = [{ url: 'https://example.com/ok', anchorText: 'OK Link', rawHref: '/ok' }];
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ links }));
    checkLinks.mockResolvedValue([
      { status: 'ok', url: 'https://example.com/ok', statusCode: 429 },
    ]);

    await handleStartLinkCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults[0]).toEqual({
      status: 'ok',
      url: 'https://example.com/ok',
      anchorText: 'OK Link',
      statusCode: 429,
    });
  });

  test('handleStartLinkCheck with LinkCheckResultOk without statusCode stores LinkResultOk without statusCode (not undefined, not NaN)', async () => {
    const links = [{ url: 'https://example.com/ok', anchorText: 'OK Link', rawHref: '/ok' }];
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ links }));
    checkLinks.mockResolvedValue([
      { status: 'ok', url: 'https://example.com/ok' },
    ]);

    await handleStartLinkCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults[0].statusCode).toBeUndefined();
    expect('statusCode' in result.linkResults[0]).toBe(false);
  });

  test('extraction failure stores linkResults: null and semanticCoverage: null', async () => {
    mockTabsSendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await handleStartLinkCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toBeNull();
    expect(result.semanticCoverage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests — handleStartSemanticCheck() orchestration
// Validates: Requirements 5.1, 5.3
// ---------------------------------------------------------------------------

describe('handleStartSemanticCheck() orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorageSet.mockResolvedValue(undefined);
    mockTabsQuery.mockResolvedValue([{ id: 1 }]);
    generateOutdatedSectionSuggestion.mockReturnValue({
      problemType: 'outdated_section',
      severity: 'medium',
      location: 'some section',
      description: 'outdated',
    });
  });

  // -------------------------------------------------------------------------
  // Test: START_SEMANTIC_CHECK message invokes handleStartSemanticCheck;
  // checkLinks is NOT called.
  // -------------------------------------------------------------------------
  test('START_SEMANTIC_CHECK message invokes handleStartSemanticCheck; checkLinks is NOT called', async () => {
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse());
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });

    await handleStartSemanticCheck(makeSender(1));

    expect(checkLinks).not.toHaveBeenCalled();

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;
    expect(finalState.status).toBe('complete');
    expect(finalState.result.brokenLinks).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Test: extraction failure writes semanticCheckError and does not call runSemanticCheck.
  // -------------------------------------------------------------------------
  test('extraction failure writes semanticCheckError and does not call runSemanticCheck', async () => {
    mockTabsSendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await handleStartSemanticCheck(makeSender(1));

    expect(runSemanticCheck).not.toHaveBeenCalled();

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;
    expect(finalState.status).toBe('complete');
    expect(finalState.result.semanticCheckError).toBe('Cannot check this page type.');
  });

  // -------------------------------------------------------------------------
  // Test: semantic API failure forwards semanticCheckError in the result.
  // -------------------------------------------------------------------------
  test('semantic API failure forwards semanticCheckError in the result', async () => {
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse());
    runSemanticCheck.mockResolvedValue({
      outdatedSections: [],
      semanticCheckError: 'Semantic check timed out — re-run the check to try again.',
    });

    await handleStartSemanticCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const finalState = lastCall[0].checkState;
    expect(finalState.status).toBe('complete');
    expect(finalState.result.semanticCheckError).toContain('timed out');
    expect(finalState.result.brokenLinks).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Task 4.1 — linkResults and semanticCoverage population in handleStartSemanticCheck
  // Validates: Requirements 1.4, 2.1, 2.5
  // -------------------------------------------------------------------------

  test('semantic-only check stores linkResults: null and a populated semanticCoverage', async () => {
    const textContent = 'This is the page text for semantic analysis.';
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ textContent }));
    runSemanticCheck.mockResolvedValue({ outdatedSections: [] });

    await handleStartSemanticCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toBeNull();
    expect(result.semanticCoverage).not.toBeNull();
    expect(result.semanticCoverage.totalCharCount).toBe(textContent.length);
    // Short text is not truncated, so submitted === total
    expect(result.semanticCoverage.submittedCharCount).toBe(textContent.length);
    expect(result.semanticCoverage.submittedCharCount).toBeLessThanOrEqual(
      result.semanticCoverage.totalCharCount,
    );
  });

  test('semantic check with LLM failure still stores semanticCoverage with correct char counts', async () => {
    const textContent = 'Page content that will be submitted to the LLM but it will fail.';
    mockTabsSendMessage.mockResolvedValue(makePageDataResponse({ textContent }));
    runSemanticCheck.mockResolvedValue({
      outdatedSections: [],
      semanticCheckError: 'Semantic check timed out — re-run the check to try again.',
    });

    await handleStartSemanticCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toBeNull();
    expect(result.semanticCheckError).toContain('timed out');
    expect(result.semanticCoverage).not.toBeNull();
    expect(result.semanticCoverage.totalCharCount).toBe(textContent.length);
    expect(result.semanticCoverage.submittedCharCount).toBe(textContent.length);
  });

  test('extraction failure stores linkResults: null and semanticCoverage: null', async () => {
    mockTabsSendMessage.mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );

    await handleStartSemanticCheck(makeSender(1));

    const lastCall = mockStorageSet.mock.calls[mockStorageSet.mock.calls.length - 1];
    const { result } = lastCall[0].checkState;

    expect(result.linkResults).toBeNull();
    expect(result.semanticCoverage).toBeNull();
  });
});
