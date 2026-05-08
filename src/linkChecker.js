/**
 * @fileoverview Link checker for the Course Content Monitor extension.
 * All fetch calls run in the background service worker context.
 */

// ---------------------------------------------------------------------------
// Soft-404 detection registry
// ---------------------------------------------------------------------------

/**
 * Map from hostname to an array of string patterns that indicate a soft 404.
 * If any pattern is found (case-insensitive substring match) in the first
 * SOFT_404_BODY_PREFIX_BYTES bytes of the response body, the link is
 * classified as broken with reason.type === "content_404".
 *
 * @type {Record<string, string[]>}
 */
const SOFT_404_PATTERNS = {
  'github.com': ['Not Found', '404'],
};

/** Number of bytes to read from the response body for soft-404 detection. */
const SOFT_404_BODY_PREFIX_BYTES = 4096;

/**
 * Reads the first SOFT_404_BODY_PREFIX_BYTES bytes of a response body and
 * checks whether any soft-404 pattern for the given hostname is present.
 *
 * Returns false immediately (without reading the body) if the hostname is
 * not in SOFT_404_PATTERNS.
 *
 * @param {Response} response - a fetch Response with a readable body
 * @param {string} hostname
 * @returns {Promise<boolean>} true if a soft-404 pattern is detected
 */
async function checkBodyForSoft404(response, hostname) {
  const patterns = SOFT_404_PATTERNS[hostname];
  if (!patterns) return false;

  const reader = response.body.getReader();
  const chunks = [];
  let bytesRead = 0;

  try {
    while (bytesRead < SOFT_404_BODY_PREFIX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = SOFT_404_BODY_PREFIX_BYTES - bytesRead;
      const slice = value.length <= remaining ? value : value.subarray(0, remaining);
      chunks.push(slice);
      bytesRead += slice.length;
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const bodyText = new TextDecoder().decode(combined);
  return patterns.some((pattern) => bodyText.toLowerCase().includes(pattern.toLowerCase()));
}

// ---------------------------------------------------------------------------
// classifyStatusCode
// ---------------------------------------------------------------------------

/**
 * Classifies an HTTP status code as "broken" or "ok".
 *
 * @param {number} statusCode
 * @returns {"broken" | "ok"}
 */
export function classifyStatusCode(statusCode) {
  if (statusCode >= 400 && statusCode <= 599) {
    return 'broken';
  }
  return 'ok';
}

// ---------------------------------------------------------------------------
// checkSingleLink
// ---------------------------------------------------------------------------

/**
 * Checks a single link for reachability.
 * Uses redirect: 'follow' so the browser handles redirects natively.
 * Falls back from HEAD to GET+Range on 405 or 403 responses.
 * Retries once on timeout before reporting the link as broken.
 *
 * @param {import('./types.js').LinkEntry} link
 * @param {import('./types.js').LinkCheckOptions} options
 * @returns {Promise<import('./types.js').LinkCheckResult>}
 */
export async function checkSingleLink(link, options) {
  const opts = {
    timeoutMs: 10_000,
    maxRedirects: 5,
    concurrency: 10,
    perDomainConcurrency: 2,
    retryOnTimeout: 1,
    ...options,
  };

  const url = link.url;

  /**
   * Build a broken-link result for the original link entry.
   * @param {import('./types.js').BrokenLinkReason} reason
   * @returns {import('./types.js').LinkCheckResult}
   */
  function broken(reason) {
    return {
      status: 'broken',
      link: {
        url: link.url,
        anchorText: link.anchorText,
        reason,
      },
    };
  }

  /**
   * Race a fetch promise against a timeout.
   * Returns the fetch response or throws an AbortError-like object on timeout.
   * @param {() => Promise<Response>} fetchFn
   * @returns {Promise<Response>}
   */
  function withTimeout(fetchFn) {
    return new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      }, opts.timeoutMs);

      fetchFn().then(
        (res) => { clearTimeout(timerId); resolve(res); },
        (err) => { clearTimeout(timerId); reject(err); }
      );
    });
  }

  const maxAttempts = 1 + opts.retryOnTimeout; // initial attempt + retries

  let attemptCount = 0;
  let soft404Result = 'not_checked';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptCount++;

    const isRetry = attempt > 1;
    if (isRetry) {
      console.log(`[linkChecker] HEAD ${url} — retry ${attempt - 1} after timeout`);
    }

    let response;
    try {
      console.log(`[linkChecker] HEAD ${url}`);
      response = await withTimeout(() =>
        fetch(url, {
          method: 'HEAD',
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        })
      );
    } catch (err) {
      console.log(`[linkChecker] HEAD ${url} → THREW ${err.name}: ${err.message}`);
      if (err.name === 'AbortError') {
        if (attempt < maxAttempts) continue; // retry on timeout
        return { ...broken({ type: 'timeout' }), attemptCount, soft404Result };
      }
      return { ...broken({ type: 'network_error', message: err.message ?? String(err) }), attemptCount, soft404Result };
    }

    const status = response.status;
    console.log(`[linkChecker] HEAD ${url} → ${status} (type: ${response.type})`);

    // 405, 403, 404, or 429 — server doesn't support HEAD, blocks it, returns
    // SPA-style 404 for HEAD (e.g. bsky.app), or rate-limits HEAD specifically.
    // Retry with GET + Range before concluding the link is broken.
    if (status === 405 || status === 403 || status === 404 || status === 429) {
      let getResponse;
      try {
        console.log(`[linkChecker] GET (Range) ${url}`);
        getResponse = await withTimeout(() =>
          fetch(url, {
            method: 'GET',
            redirect: 'follow',
            headers: {
              Range: 'bytes=0-0',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
          })
        );
      } catch (err) {
        console.log(`[linkChecker] GET (Range) ${url} → THREW ${err.name}: ${err.message}`);
        if (err.name === 'AbortError') {
          if (attempt < maxAttempts) continue; // retry the whole attempt on timeout
          return { ...broken({ type: 'timeout' }), attemptCount, soft404Result };
        }
        return { ...broken({ type: 'network_error', message: err.message ?? String(err) }), attemptCount, soft404Result };
      }

      const getStatus = getResponse.status;
      console.log(`[linkChecker] GET (Range) ${url} → ${getStatus} (type: ${getResponse.type})`);

      // 403 and 429 on the GET fallback mean the server is reachable and
      // actively responding — the link is not broken, the server is just
      // blocking automated requests or rate-limiting us. Discard body here.
      if (getStatus === 403 || getStatus === 429) {
        if (getResponse.body) {
          try { getResponse.body.cancel(); } catch { /* ignore */ }
        }
        console.log(`[linkChecker] OK (bot-blocked/rate-limited) ${url} — GET returned ${getStatus}`);
        return { status: 'ok', url, statusCode: getStatus, attemptCount, soft404Result };
      }

      if (getStatus >= 400 && getStatus < 600) {
        if (getResponse.body) {
          try { getResponse.body.cancel(); } catch { /* ignore */ }
        }
        console.log(`[linkChecker] BROKEN ${url} — GET returned ${getStatus}`);
        return { ...broken({ type: 'http_error', statusCode: getStatus }), attemptCount, soft404Result };
      }

      // 2xx GET fallback — check body for soft-404 before reporting ok
      const getFallbackHostname = new URL(url).hostname;
      if (SOFT_404_PATTERNS[getFallbackHostname]) {
        // getResponse body is still open — pass it directly to checkBodyForSoft404
        // which reads the prefix and cancels the reader internally
        const isSoft404 = await checkBodyForSoft404(getResponse, getFallbackHostname);
        soft404Result = isSoft404 ? 'triggered' : 'passed';
        if (isSoft404) {
          console.log(`[linkChecker] BROKEN (content_404) ${url}`);
          return { ...broken({ type: 'content_404' }), attemptCount, soft404Result };
        }
      } else {
        // Not a soft-404 host — discard body and return ok
        if (getResponse.body) {
          try { getResponse.body.cancel(); } catch { /* ignore */ }
        }
      }
      return { status: 'ok', url, statusCode: getStatus, attemptCount, soft404Result };
    }

    // 4xx / 5xx — broken
    if (status >= 400 && status < 600) {
      console.log(`[linkChecker] BROKEN ${url} — HEAD returned ${status}`);
      return { ...broken({ type: 'http_error', statusCode: status }), attemptCount, soft404Result };
    }

    // 2xx (or anything else) — check body for soft-404 before reporting ok
    const hostname = new URL(url).hostname;
    if (SOFT_404_PATTERNS[hostname]) {
      // HEAD responses have no body; issue a GET to read the body prefix
      let getResponse;
      try {
        console.log(`[linkChecker] GET (soft-404 check) ${url}`);
        getResponse = await withTimeout(() =>
          fetch(url, {
            method: 'GET',
            redirect: 'follow',
            headers: {
              Range: `bytes=0-${SOFT_404_BODY_PREFIX_BYTES - 1}`,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
          })
        );
      } catch (err) {
        console.log(`[linkChecker] GET (soft-404 check) ${url} → THREW ${err.name}: ${err.message}`);
        if (err.name === 'AbortError') {
          if (attempt < maxAttempts) continue;
          return { ...broken({ type: 'timeout' }), attemptCount, soft404Result };
        }
        return { ...broken({ type: 'network_error', message: err.message ?? String(err) }), attemptCount, soft404Result };
      }

      const isSoft404 = await checkBodyForSoft404(getResponse, hostname);
      soft404Result = isSoft404 ? 'triggered' : 'passed';
      if (isSoft404) {
        console.log(`[linkChecker] BROKEN (content_404) ${url}`);
        return { ...broken({ type: 'content_404' }), attemptCount, soft404Result };
      }
    }

    return { status: 'ok', url, statusCode: status, attemptCount, soft404Result };
  }

  // Should be unreachable, but satisfy the type checker
  /* istanbul ignore next */
  return { ...broken({ type: 'timeout' }), attemptCount, soft404Result };
}

// ---------------------------------------------------------------------------
// checkLinks — concurrency-limited batch checker
// ---------------------------------------------------------------------------

/**
 * A simple semaphore for limiting concurrency.
 * Callers acquire a slot, do their work, then release.
 */
class Semaphore {
  /**
   * @param {number} limit - maximum concurrent holders
   */
  constructor(limit) {
    this._limit = limit;
    this._active = 0;
    /** @type {Array<() => void>} */
    this._queue = [];
  }

  /**
   * Acquire a slot. Resolves when a slot is available.
   * @returns {Promise<void>}
   */
  acquire() {
    if (this._active < this._limit) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._queue.push(resolve);
    });
  }

  /**
   * Release a slot, waking the next waiter if any.
   */
  release() {
    const next = this._queue.shift();
    if (next) {
      // Hand the slot directly to the next waiter
      next();
    } else {
      this._active--;
    }
  }
}

/**
 * Checks all links in the given array for reachability.
 * Enforces both a global concurrency cap and a per-domain concurrency cap.
 * Results are returned in the same order as the input array.
 *
 * @param {import('./types.js').LinkEntry[]} links
 * @param {import('./types.js').LinkCheckOptions} options
 * @returns {Promise<import('./types.js').LinkCheckResult[]>}
 */
export async function checkLinks(links, options) {
  console.log('checkLinks() links: ', links)
  const opts = {
    timeoutMs: 10_000,
    maxRedirects: 5,
    concurrency: 10,
    perDomainConcurrency: 2,
    ...options,
  };

  const globalSem = new Semaphore(opts.concurrency);
  /** @type {Map<string, Semaphore>} */
  const domainSems = new Map();

  /**
   * Get (or create) the per-domain semaphore for a given hostname.
   * @param {string} hostname
   * @returns {Semaphore}
   */
  function getDomainSem(hostname) {
    if (!domainSems.has(hostname)) {
      domainSems.set(hostname, new Semaphore(opts.perDomainConcurrency));
    }
    return /** @type {Semaphore} */ (domainSems.get(hostname));
  }

  /**
   * Check a single link while respecting both semaphores.
   * @param {import('./types.js').LinkEntry} link
   * @returns {Promise<import('./types.js').LinkCheckResult>}
   */
  async function checkedLink(link) {
    let hostname;
    try {
      hostname = new URL(link.url).hostname;
    } catch {
      hostname = link.url;
    }

    const domainSem = getDomainSem(hostname);

    // Acquire global slot first, then domain slot
    await globalSem.acquire();
    await domainSem.acquire();
    try {
      return await checkSingleLink(link, opts);
    } finally {
      domainSem.release();
      globalSem.release();
    }
  }

  // Kick off all checks concurrently (semaphores throttle actual execution),
  // then await in input order to preserve result ordering.
  const promises = links.map((link) => checkedLink(link));
  const results = await Promise.all(promises);

  const broken = results.filter((r) => r.status === 'broken');
  if (broken.length > 0) {
    console.log(`[linkChecker] SUMMARY — ${broken.length} broken link(s):`);
    for (const r of broken) {
      console.log(`  BROKEN: ${r.link.url} — reason: ${JSON.stringify(r.link.reason)}`);
    }
  } else {
    console.log('[linkChecker] SUMMARY — all links ok');
  }

  return results;
}
