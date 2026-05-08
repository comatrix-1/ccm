/**
 * content.js — Course Content Monitor content script.
 *
 * Runs in the context of every page (declared in manifest.json).
 * Listens for EXTRACT_PAGE_DATA messages from the background service worker
 * and responds with the extracted page data.
 *
 * This file is intentionally self-contained (no ES module imports) because
 * Chrome MV3 content scripts cannot use ES module syntax directly.
 * The extraction logic from src/pageExtractor.js is inlined here.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Inline: extractLinks(doc)
  // ---------------------------------------------------------------------------

  const EXCLUDED_PROTOCOLS = new Set([
    'javascript:',
    'mailto:',
    'tel:',
    'data:',
  ]);

  /**
   * @param {Document} doc
   * @returns {Array<{url: string, anchorText: string, rawHref: string}>}
   */
  function extractLinks(doc) {
    const anchors = doc.querySelectorAll('a[href]');
    const seen = new Map();

    for (const anchor of anchors) {
      const rawHref = anchor.getAttribute('href') || '';

      if (rawHref.startsWith('#')) {
        continue;
      }

      let resolvedUrl;
      try {
        resolvedUrl = new URL(rawHref, doc.baseURI).href;
      } catch (_) {
        continue;
      }

      const protocol = resolvedUrl.split(':')[0] + ':';
      if (EXCLUDED_PROTOCOLS.has(protocol)) {
        continue;
      }

      if (seen.has(resolvedUrl)) {
        continue;
      }

      const anchorText = (anchor.textContent || '').trim();
      seen.set(resolvedUrl, { url: resolvedUrl, anchorText, rawHref });
    }

    return Array.from(seen.values());
  }

  // ---------------------------------------------------------------------------
  // Inline: extractTextContent(maxChars, doc)
  // ---------------------------------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG']);

  function getParentElement(node) {
    let current = node.parentNode;
    while (current) {
      if (current.nodeType === 1) return current;
      current = current.parentNode;
    }
    return null;
  }

  function shouldSkipElement(el, cache, win) {
    if (cache.has(el)) return cache.get(el);

    let skip = false;

    if (SKIP_TAGS.has(el.tagName)) {
      skip = true;
    }

    if (!skip && el.getAttribute('aria-hidden') === 'true') {
      skip = true;
    }

    if (!skip) {
      const inlineDisplay = el.style ? el.style.display : '';
      if (inlineDisplay === 'none') {
        skip = true;
      } else {
        try {
          const computed = win.getComputedStyle(el);
          if (computed.display === 'none') skip = true;
        } catch (_) {}
      }
    }

    if (!skip) {
      try {
        const computed = win.getComputedStyle(el);
        if (computed.visibility === 'hidden') skip = true;
      } catch (_) {}
    }

    cache.set(el, skip);
    return skip;
  }

  function isTextNodeVisible(textNode, cache, win) {
    let current = getParentElement(textNode);
    while (current) {
      if (shouldSkipElement(current, cache, win)) return false;
      current = getParentElement(current);
    }
    return true;
  }

  /**
   * @param {number} maxChars
   * @param {Document} doc
   * @returns {string}
   */
  function extractTextContent(maxChars, doc) {
    if (!doc.body) return '';
    const win = doc.defaultView;
    if (!win) return '';

    const cache = new WeakMap();
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return isTextNodeVisible(node, cache, win)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const parts = [];
    let node;
    while ((node = walker.nextNode()) !== null) {
      const text = node.nodeValue || '';
      if (text.trim().length > 0) parts.push(text);
    }

    const joined = parts.join('\n');
    const normalised = joined.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return normalised.slice(0, maxChars);
  }

  // ---------------------------------------------------------------------------
  // Inline: extractPageData(doc)
  // ---------------------------------------------------------------------------

  /**
   * @param {Document} doc
   * @returns {{links: Array, textContent: string, pageUrl: string, pageTitle: string}}
   */
  function extractPageData(doc) {
    return {
      links: extractLinks(doc),
      textContent: extractTextContent(60000, doc),
      pageUrl: doc.URL,
      pageTitle: doc.title,
    };
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (message && message.type === 'EXTRACT_PAGE_DATA') {
      try {
        const payload = extractPageData(document);
        sendResponse({ type: 'PAGE_DATA', payload });
      } catch (err) {
        sendResponse({
          type: 'EXTRACT_ERROR',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Return true to indicate we will call sendResponse (synchronously here,
      // but the pattern is required for MV3 compatibility).
      return true;
    }
  });
})();
