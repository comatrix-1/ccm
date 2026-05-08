/**
 * @fileoverview DOM extraction utilities for the Course Content Monitor extension.
 * These functions accept a `document` parameter so they can be tested in isolation
 * with synthetic jsdom documents.
 */

/** Protocols that should be excluded from link extraction. */
const EXCLUDED_PROTOCOLS = new Set([
  'javascript:',
  'mailto:',
  'tel:',
  'data:',
]);

/**
 * Extract all valid hyperlinks from a document.
 *
 * - Resolves relative hrefs to absolute URLs using `doc.baseURI`.
 * - Filters out `javascript:`, `mailto:`, `tel:`, `data:` protocols.
 * - Filters out fragment-only hrefs (href starts with `#`).
 * - Deduplicates by resolved URL; first occurrence's anchor text wins.
 *
 * @param {Document} doc
 * @returns {import('./types.js').LinkEntry[]}
 */
export function extractLinks(doc) {
  const anchors = doc.querySelectorAll('a[href]');
  /** @type {Map<string, import('./types.js').LinkEntry>} */
  const seen = new Map();

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href') ?? '';

    // Exclude fragment-only hrefs
    if (rawHref.startsWith('#')) {
      continue;
    }

    // Resolve to absolute URL
    let resolvedUrl;
    try {
      resolvedUrl = new URL(rawHref, doc.baseURI).href;
    } catch {
      // Malformed href — skip
      continue;
    }

    // Exclude unwanted protocols
    const protocol = resolvedUrl.split(':')[0] + ':';
    if (EXCLUDED_PROTOCOLS.has(protocol)) {
      continue;
    }

    // Deduplicate — first occurrence wins
    if (seen.has(resolvedUrl)) {
      continue;
    }

    const anchorText = (anchor.textContent ?? '').trim();

    seen.set(resolvedUrl, {
      url: resolvedUrl,
      anchorText,
      rawHref,
    });
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Excluded tag names for text extraction
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'IFRAME',
  'SVG',
]);

/**
 * Walk up the ancestor chain of a node and return the first element ancestor,
 * or null if there is none.
 *
 * @param {Node} node
 * @returns {Element | null}
 */
function getParentElement(node) {
  let current = node.parentNode;
  while (current) {
    if (current.nodeType === 1 /* ELEMENT_NODE */) {
      return /** @type {Element} */ (current);
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Determine whether an element should be skipped during text extraction.
 * Checks tag name, display:none, visibility:hidden, and aria-hidden.
 *
 * Results are cached in a WeakMap keyed by element reference.
 *
 * @param {Element} el
 * @param {WeakMap<Element, boolean>} cache
 * @param {Window} win
 * @returns {boolean} true if the element (and its subtree) should be skipped
 */
function shouldSkipElement(el, cache, win) {
  if (cache.has(el)) {
    return /** @type {boolean} */ (cache.get(el));
  }

  let skip = false;

  // Skip by tag name
  if (SKIP_TAGS.has(el.tagName)) {
    skip = true;
  }

  // Skip aria-hidden
  if (!skip && el.getAttribute('aria-hidden') === 'true') {
    skip = true;
  }

  // Skip display:none — check inline style first (jsdom workaround), then getComputedStyle
  if (!skip) {
    const inlineDisplay = el.style ? el.style.display : '';
    if (inlineDisplay === 'none') {
      skip = true;
    } else {
      try {
        const computed = win.getComputedStyle(el);
        if (computed.display === 'none') {
          skip = true;
        }
      } catch {
        // getComputedStyle not available — fall back to inline check only
      }
    }
  }

  // Skip visibility:hidden
  if (!skip) {
    try {
      const computed = win.getComputedStyle(el);
      if (computed.visibility === 'hidden') {
        skip = true;
      }
    } catch {
      // ignore
    }
  }

  cache.set(el, skip);
  return skip;
}

/**
 * Check whether any ancestor of a text node should cause it to be skipped.
 *
 * @param {Node} textNode
 * @param {WeakMap<Element, boolean>} cache
 * @param {Window} win
 * @returns {boolean}
 */
function isTextNodeVisible(textNode, cache, win) {
  let current = getParentElement(textNode);
  while (current) {
    if (shouldSkipElement(current, cache, win)) {
      return false;
    }
    current = getParentElement(current);
  }
  return true;
}

/**
 * Extract visible text content from a document.
 *
 * - Uses TreeWalker with NodeFilter.SHOW_TEXT on doc.body.
 * - Skips text inside SCRIPT, STYLE, NOSCRIPT, IFRAME, SVG.
 * - Skips text inside elements with display:none, visibility:hidden, or aria-hidden="true".
 * - Caches getComputedStyle results in a WeakMap.
 * - Joins visible text nodes with newlines, normalises whitespace, truncates to maxChars.
 *
 * @param {number} maxChars - Maximum number of characters to return (default 60000)
 * @param {Document} doc
 * @returns {string}
 */
export function extractTextContent(maxChars = 60000, doc) {
  if (!doc.body) {
    return '';
  }

  const win = doc.defaultView;
  if (!win) {
    return '';
  }

  /** @type {WeakMap<Element, boolean>} */
  const cache = new WeakMap();

  const walker = doc.createTreeWalker(
    doc.body,
    // NodeFilter.SHOW_TEXT = 4
    4,
    {
      acceptNode(node) {
        if (!isTextNodeVisible(node, cache, win)) {
          // NodeFilter.FILTER_REJECT = 2
          return 2;
        }
        // NodeFilter.FILTER_ACCEPT = 1
        return 1;
      },
    }
  );

  const parts = [];
  let node;
  while ((node = walker.nextNode()) !== null) {
    const text = node.nodeValue ?? '';
    if (text.trim().length > 0) {
      parts.push(text);
    }
  }

  // Join, normalise whitespace, truncate
  const joined = parts.join('\n');
  const normalised = joined.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  return normalised.slice(0, maxChars);
}

/**
 * Extract all page data needed for analysis.
 *
 * @param {Document} doc
 * @returns {import('./types.js').PageData}
 */
export function extractPageData(doc) {
  return {
    links: extractLinks(doc),
    textContent: extractTextContent(60000, doc),
    pageUrl: doc.URL,
    pageTitle: doc.title,
  };
}
