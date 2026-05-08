/**
 * @fileoverview Fix suggestion generator for the Course Content Monitor extension.
 * Generates human-readable FixSuggestion records from BrokenLink and OutdatedSection inputs.
 * Runs in the background service worker context.
 */

/** @typedef {import('./types.js').BrokenLink} BrokenLink */
/** @typedef {import('./types.js').OutdatedSection} OutdatedSection */
/** @typedef {import('./types.js').FixSuggestion} FixSuggestion */

/**
 * Generates a FixSuggestion for a broken link.
 *
 * - severity is always "high" (deliberate design choice: a dead link has no fallback)
 * - location is the anchor text, or the URL if anchor text is empty
 * - description is "Link is broken: {reason}. URL: {url}"
 * - candidateUrl: if the broken URL uses http://, attempt https:// substitution;
 *   if the https:// version returns a 2xx response, set candidateUrl; otherwise omit
 *
 * @param {BrokenLink} brokenLink
 * @returns {Promise<FixSuggestion>}
 */
export async function generateBrokenLinkSuggestion(brokenLink) {
  const location = brokenLink.anchorText || brokenLink.url;
  const description = `Link is broken: ${brokenLink.reason.type}. URL: ${brokenLink.url}`;

  /** @type {string | undefined} */
  let candidateUrl;

  if (brokenLink.url.startsWith('http://')) {
    const httpsUrl = brokenLink.url.replace(/^http:\/\//, 'https://');
    try {
      const response = await fetch(httpsUrl, { method: 'HEAD' });
      if (response.status >= 200 && response.status < 300) {
        candidateUrl = httpsUrl;
      }
    } catch {
      // Network error — candidateUrl remains undefined
    }
  }

  /** @type {FixSuggestion} */
  const suggestion = {
    problemType: 'broken_link',
    severity: 'high',
    location,
    description,
  };

  if (candidateUrl !== undefined) {
    suggestion.candidateUrl = candidateUrl;
  }

  return suggestion;
}

/**
 * Generates a FixSuggestion for an outdated section.
 *
 * - severity comes from the section's severity field (set by the LLM)
 * - location is the first 80 characters of sectionText, with "..." appended if truncated
 * - description is the section's reason field (set by the LLM)
 *
 * @param {OutdatedSection} section
 * @returns {FixSuggestion}
 */
export function generateOutdatedSectionSuggestion(section) {
  const MAX_LOCATION_LENGTH = 80;
  const truncated = section.sectionText.length > MAX_LOCATION_LENGTH;
  const location = truncated
    ? section.sectionText.slice(0, MAX_LOCATION_LENGTH) + '...'
    : section.sectionText;

  return {
    problemType: 'outdated_section',
    severity: section.severity,
    location,
    description: section.reason,
  };
}
