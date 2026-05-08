/**
 * @fileoverview Semantic checker — LLM-based evaluation of page content for outdated sections.
 * Runs in the background service worker context.
 */

/** @typedef {import('./types.js').OutdatedSection} OutdatedSection */
/** @typedef {import('./types.js').Severity} Severity */
/** @typedef {import('./types.js').SemanticCheckOptions} SemanticCheckOptions */

/**
 * @typedef {Object} SemanticCheckResult
 * @property {OutdatedSection[]} outdatedSections
 * @property {string} [semanticCheckError]
 */

const VALID_SEVERITIES = new Set(['high', 'medium', 'low']);

const PROMPT_TEMPLATE = `You are a technical content auditor. Analyse the following course page content and identify sections that are potentially outdated or inaccurate for the tools and technologies described.

Look specifically for:
- deprecated features or APIs that have been removed or renamed
- old UI flows that no longer match the current product
- tool behaviour that is likely to have changed since the content was written
- references to version numbers, pricing, or feature availability that may be outdated or stale

For each flagged section, respond with a JSON object in this exact format:
{
  "flaggedSections": [
    {
      "sectionText": "<the exact excerpt from the content>",
      "reason": "<why this section may be outdated>",
      "severity": "high" | "medium" | "low"
    }
  ]
}

Severity guide:
- high: the inaccuracy would directly mislead a learner trying to follow the instructions
- medium: the content is likely stale but the core instruction remains broadly correct
- low: the content may be slightly out of date but is unlikely to cause confusion

If no sections are flagged, return: { "flaggedSections": [] }

Page content:
---
{textContent}
---`;

/**
 * Builds the prompt sent to the LLM.
 * Always includes instructions to identify deprecated features,
 * outdated API names, old UI flows, and changed tool behaviour.
 *
 * @param {string} textContent
 * @returns {string}
 */
export function buildSemanticPrompt(textContent) {
  return PROMPT_TEMPLATE.replace('{textContent}', textContent);
}

/**
 * Parses the LLM's JSON response into OutdatedSection records.
 * Validates each entry; discards invalid or hallucinated entries.
 *
 * @param {object} llmResponse
 * @param {string} textContent - original page text for hallucination validation
 * @returns {OutdatedSection[]}
 */
export function parseLLMResponse(llmResponse, textContent) {
  const { flaggedSections } = llmResponse ?? {};

  if (!Array.isArray(flaggedSections)) {
    return [];
  }

  /** @type {OutdatedSection[]} */
  const results = [];

  for (const entry of flaggedSections) {
    // Validate required fields
    if (
      !entry ||
      typeof entry.sectionText !== 'string' ||
      !entry.sectionText ||
      typeof entry.reason !== 'string' ||
      !entry.reason ||
      !VALID_SEVERITIES.has(entry.severity)
    ) {
      continue;
    }

    // Hallucination guard: sectionText must appear in the original page text
    if (!textContent.includes(entry.sectionText)) {
      console.warn(
        `[semanticChecker] Discarding entry — sectionText not found in page content: "${entry.sectionText.slice(0, 80)}"`,
      );
      continue;
    }

    results.push({
      sectionText: entry.sectionText,
      reason: entry.reason,
      severity: /** @type {Severity} */ (entry.severity),
    });
  }

  return results;
}

/**
 * Sends page text content to the LLM for semantic evaluation.
 * Reads the API key from chrome.storage.local.
 *
 * @param {string} textContent - extracted page text (pre-truncated)
 * @param {Partial<SemanticCheckOptions>} options
 * @returns {Promise<SemanticCheckResult>}
 */
export async function runSemanticCheck(textContent, options = {}) {
  const model = options.model ?? 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
  // Reasoning models on free tiers can be very slow — use a generous timeout.
  // Can be overridden via options.timeoutMs for testing.
  const timeoutMs = options.timeoutMs ?? 120_000;

  console.log(`[semanticChecker] Starting semantic check — model: ${model}, timeout: ${timeoutMs}ms, content length: ${textContent.length} chars`);

  // Read API key from storage
  const stored = await chrome.storage.local.get('openrouterApiKey');
  // Trim whitespace and strip any newline/carriage-return characters that would
  // cause Chrome to silently drop the Authorization header entirely.
  const apiKey = typeof stored?.openrouterApiKey === 'string'
    ? stored.openrouterApiKey.replace(/[\r\n]/g, '').trim()
    : '';

  if (!apiKey) {
    console.warn('[semanticChecker] No API key found in storage — aborting');
    return {
      outdatedSections: [],
      semanticCheckError:
        'No API key configured. Please add your OpenRouter API key in Settings.',
    };
  }

  console.log(`[semanticChecker] API key found (length: ${apiKey.length}) — building prompt and sending request`);

  const prompt = buildSemanticPrompt(textContent);
  const controller = new AbortController();
  const startTime = Date.now();
  const timer = setTimeout(() => {
    console.warn(`[semanticChecker] Timeout fired after ${Date.now() - startTime}ms — aborting fetch`);
    controller.abort();
  }, timeoutMs);

  let rawJson;
  try {
    console.log(`[semanticChecker] Sending fetch to OpenRouter (${new Date().toISOString()})`);
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    console.log(`[semanticChecker] Response received — status: ${response.status}, elapsed: ${Date.now() - startTime}ms`);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`[semanticChecker] HTTP error ${response.status}: ${body}`);
      return {
        outdatedSections: [],
        semanticCheckError: `Semantic check failed: HTTP ${response.status}. ${body}`.trim(),
      };
    }

    rawJson = await response.json();
    console.log(`[semanticChecker] Response JSON parsed — elapsed: ${Date.now() - startTime}ms`);
  } catch (err) {
    const elapsed = Date.now() - startTime;
    if (err && (err.name === 'AbortError' || err.message === 'timeout')) {
      console.error(`[semanticChecker] Fetch aborted (timeout) after ${elapsed}ms — err.name: ${err.name}`);
      return {
        outdatedSections: [],
        semanticCheckError: 'Semantic check timed out — re-run the check to try again.',
      };
    }
    console.error(`[semanticChecker] Fetch threw unexpected error after ${elapsed}ms:`, err);
    return {
      outdatedSections: [],
      semanticCheckError: `Semantic check returned an unexpected response. Link results are shown below.`,
    };
  } finally {
    clearTimeout(timer);
  }

  // Extract content string from OpenAI response envelope.
  // Some reasoning models (e.g. nvidia/nemotron-3-nano-omni-30b-a3b-reasoning) return
  // null for `content` and put their output in the `reasoning` field instead.
  // Fall back to `reasoning` (or its alias `reasoning_content`) when `content` is absent.
  let llmResponse;
  try {
    const message = rawJson?.choices?.[0]?.message;
    const content =
      typeof message?.content === 'string'
        ? message.content
        : typeof message?.reasoning === 'string'
          ? message.reasoning
          : typeof message?.reasoning_content === 'string'
            ? message.reasoning_content
            : null;
    console.log(`[semanticChecker] Raw content from LLM (first 200 chars): ${String(content).slice(0, 200)}`);
    if (typeof content !== 'string') throw new Error('no content field in response');
    // Strip markdown code fences that reasoning models sometimes wrap around JSON
    const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    llmResponse = JSON.parse(stripped);
    console.log(`[semanticChecker] Parsed LLM JSON — flaggedSections count: ${llmResponse?.flaggedSections?.length ?? 'N/A'}`);
  } catch (err) {
    console.error('[semanticChecker] Failed to parse LLM response content:', err);
    return {
      outdatedSections: [],
      semanticCheckError:
        'Semantic check returned an unexpected response. Link results are shown below.',
    };
  }

  const parsed = parseLLMResponse(llmResponse, textContent);
  console.log(`[semanticChecker] parseLLMResponse returned ${parsed.length} valid entries`);

  // (block removed — all entries being discarded is a valid outcome, not a parse error)

  // Deduplicate by exact sectionText (keep first occurrence)
  const seen = new Set();
  const deduplicated = parsed.filter((entry) => {
    if (seen.has(entry.sectionText)) return false;
    seen.add(entry.sectionText);
    return true;
  });

  console.log(`[semanticChecker] Done — returning ${deduplicated.length} deduplicated sections`);
  return { outdatedSections: deduplicated };
}
