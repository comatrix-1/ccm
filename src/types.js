/**
 * @fileoverview Shared JSDoc type definitions for the Course Content Monitor extension.
 * These types are used across all extension contexts: background service worker,
 * content script, and popup UI.
 */

/**
 * A hyperlink found on the page.
 * @typedef {Object} LinkEntry
 * @property {string} url - Absolute URL (resolved from rawHref)
 * @property {string} anchorText - Visible text of the <a> element (may be empty string)
 * @property {string} rawHref - Original href attribute value
 */

/**
 * Result of checking a single link.
 * @typedef {LinkCheckResultOk | LinkCheckResultBroken} LinkCheckResult
 */

/**
 * @typedef {Object} LinkCheckResultOk
 * @property {"ok"} status
 * @property {string} url
 * @property {number} [statusCode] - HTTP status code of the response that led to the OK classification
 * @property {number} attemptCount - Number of fetch attempts made (including retries)
 * @property {string} soft404Result - Outcome of the soft-404 check: "not_checked" | "passed" | "triggered"
 */

/**
 * @typedef {Object} LinkCheckResultBroken
 * @property {"broken"} status
 * @property {BrokenLink} link
 * @property {number} attemptCount - Number of fetch attempts made (including retries)
 * @property {string} soft404Result - Outcome of the soft-404 check: "not_checked" | "passed" | "triggered"
 */

/**
 * A link confirmed as broken.
 * @typedef {Object} BrokenLink
 * @property {string} url
 * @property {string} anchorText
 * @property {BrokenLinkReason} reason
 * @property {number} [statusCode] - Present for HTTP errors; absent for timeout/redirect_loop
 */

/**
 * The reason a link was classified as broken.
 * @typedef {BrokenLinkReasonHttpError | BrokenLinkReasonTimeout | BrokenLinkReasonRedirectLoop | BrokenLinkReasonNetworkError | BrokenLinkReasonContent404} BrokenLinkReason
 */

/**
 * @typedef {Object} BrokenLinkReasonHttpError
 * @property {"http_error"} type
 * @property {number} statusCode
 */

/**
 * @typedef {Object} BrokenLinkReasonTimeout
 * @property {"timeout"} type
 */

/**
 * @typedef {Object} BrokenLinkReasonRedirectLoop
 * @property {"redirect_loop"} type
 * @property {number} hopCount
 */

/**
 * @typedef {Object} BrokenLinkReasonNetworkError
 * @property {"network_error"} type
 * @property {string} message
 */

/**
 * @typedef {Object} BrokenLinkReasonContent404
 * @property {"content_404"} type
 */

/**
 * Result of checking a single link, including anchor text for display in reports.
 * @typedef {LinkResultOk | LinkResultBroken} LinkResult
 */

/**
 * @typedef {Object} LinkResultOk
 * @property {"ok"} status
 * @property {string} url
 * @property {string} anchorText
 * @property {number} [statusCode] - HTTP status code; absent for results stored before this feature
 * @property {number} [attemptCount] - Number of fetch attempts made; absent for results stored before this feature
 * @property {string} [soft404Result] - Soft-404 check outcome; absent for results stored before this feature
 */

/**
 * @typedef {Object} LinkResultBroken
 * @property {"broken"} status
 * @property {string} url
 * @property {string} anchorText
 * @property {BrokenLinkReason} reason
 * @property {number} [attemptCount] - Number of fetch attempts made; absent for results stored before this feature
 * @property {string} [soft404Result] - Soft-404 check outcome; absent for results stored before this feature
 */

/**
 * Describes how much of the page text was submitted to the LLM.
 * @typedef {Object} SemanticCoverage
 * @property {number} submittedCharCount - chars sent to LLM after truncation
 * @property {number} totalCharCount - chars in full extracted text before truncation
 */

/**
 * Severity of a detected problem.
 * @typedef {"high" | "medium" | "low"} Severity
 */

/**
 * A section of page content flagged as outdated by the LLM.
 * @typedef {Object} OutdatedSection
 * @property {string} sectionText - The flagged text excerpt
 * @property {string} reason - Why it was flagged
 * @property {Severity} severity
 */

/**
 * A human-readable suggestion for fixing a detected problem.
 * @typedef {Object} FixSuggestion
 * @property {"broken_link" | "outdated_section"} problemType
 * @property {Severity} severity
 * @property {string} location - Anchor text or section excerpt (for display)
 * @property {string} description - What is wrong
 * @property {string} [candidateUrl] - Only for broken links where a replacement can be inferred
 */

/**
 * Data extracted from the active page by the content script.
 * @typedef {Object} PageData
 * @property {LinkEntry[]} links
 * @property {string} textContent - Truncated visible text
 * @property {string} pageUrl
 * @property {string} pageTitle
 */

/**
 * The complete result of a check run.
 * @typedef {Object} CheckResult
 * @property {string} pageUrl
 * @property {string} pageTitle
 * @property {BrokenLink[]} brokenLinks
 * @property {OutdatedSection[]} outdatedSections
 * @property {FixSuggestion[]} fixSuggestions
 * @property {string} checkedAt - ISO 8601 string, e.g. new Date().toISOString()
 * @property {string} [semanticCheckError] - Present when the semantic check failed; link results are still valid
 * @property {LinkResult[] | null} [linkResults] - null when no link check ran; [] when check ran but page had no links
 * @property {SemanticCoverage | null} [semanticCoverage] - null when no semantic check ran
 */

/**
 * Progress update sent from background to popup during a check.
 * @typedef {Object} ProgressUpdate
 * @property {"extracting" | "checking_links" | "semantic_check" | "done"} phase
 * @property {number} [linksChecked]
 * @property {number} [totalLinks]
 */

/**
 * Persisted check state — written by the background worker to chrome.storage.local
 * under the key "checkState" at each phase transition.
 * @typedef {CheckStateIdle | CheckStateInProgress | CheckStateComplete} CheckState
 */

/**
 * @typedef {Object} CheckStateIdle
 * @property {"idle"} status
 */

/**
 * @typedef {Object} CheckStateInProgress
 * @property {"in_progress"} status
 * @property {ProgressUpdate["phase"]} phase
 * @property {number} startedAt - Timestamp in ms (Date.now())
 */

/**
 * @typedef {Object} CheckStateComplete
 * @property {"complete"} status
 * @property {CheckResult} result
 */

/**
 * Popup UI state — derived from CheckState by checkStateToPopupState().
 * @typedef {PopupStateIdle | PopupStateLoading | PopupStateComplete | PopupStateError} PopupState
 */

/**
 * @typedef {Object} PopupStateIdle
 * @property {"idle"} status
 */

/**
 * @typedef {Object} PopupStateLoading
 * @property {"loading"} status
 * @property {ProgressUpdate} progress
 */

/**
 * @typedef {Object} PopupStateComplete
 * @property {"complete"} status
 * @property {CheckResult} result
 */

/**
 * @typedef {Object} PopupStateError
 * @property {"error"} status
 * @property {string} message
 */

/**
 * Options for link checking.
 * @typedef {Object} LinkCheckOptions
 * @property {number} timeoutMs - Default: 10000
 * @property {number} maxRedirects - Default: 5
 * @property {number} concurrency - Default: 10 (global cap across all domains)
 * @property {number} perDomainConcurrency - Default: 2 (max concurrent requests per hostname)
 */

/**
 * Options for semantic checking.
 * @typedef {Object} SemanticCheckOptions
 * @property {string} model - Default: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
 * @property {number} timeoutMs - Default: 90000 (ms before the LLM request is aborted)
 * @property {number} maxContentChars - Default: 60000 (character pre-truncation limit)
 * @property {number} maxTokens - Default: 12000 (token limit after tiktoken encoding)
 */
