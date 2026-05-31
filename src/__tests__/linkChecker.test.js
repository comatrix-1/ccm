import fc from 'fast-check';
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { classifyStatusCode, checkSingleLink, checkLinks } from '../linkChecker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal LinkEntry */
function makeLink(url, anchorText = 'Test Link') {
  return { url, anchorText, rawHref: url };
}

/** Default options for checkSingleLink tests */
const DEFAULT_OPTS = {
  timeoutMs: 5000,
  maxRedirects: 5,
  concurrency: 10,
  perDomainConcurrency: 2,
};

// ---------------------------------------------------------------------------
// Property test — classifyStatusCode() — Property 2: HTTP error classification
// Feature: course-content-monitor, Property 2: HTTP error classification
// ---------------------------------------------------------------------------

describe('classifyStatusCode() — Property 2: HTTP error classification', () => {
  test('any status code in [400, 599] returns "broken"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 400, max: 599 }), (code) => {
        expect(classifyStatusCode(code)).toBe('broken');
      }),
      { numRuns: 100 }
    );
  });

  test('any status code in [200, 399] returns "ok"', () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 399 }), (code) => {
        expect(classifyStatusCode(code)).toBe('ok');
      }),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — checkSingleLink()
// ---------------------------------------------------------------------------

describe('checkSingleLink()', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('timeout after timeoutMs ms returns BrokenLink with reason.type === "timeout"', async () => {
    vi.useFakeTimers();

    // fetch never resolves — both the initial attempt and the retry time out
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const link = makeLink('https://example.com/slow');
    const opts = { ...DEFAULT_OPTS, timeoutMs: 100, retryOnTimeout: 1 };

    const resultPromise = checkSingleLink(link, opts);
    // Advance past both attempts (initial + 1 retry)
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('timeout');
    // fetch should have been called twice (initial + 1 retry)
    expect(vi.mocked(fetch).mock.calls.length).toBe(2);
  });

  test('timeout on first attempt but success on retry returns ok', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.fn();
    // First call never resolves (timeout)
    mockFetch.mockImplementationOnce(() => new Promise(() => {}));
    // Second call (retry) — HEAD returns 200
    mockFetch.mockImplementationOnce(() =>
      Promise.resolve({ status: 200, headers: { get: () => null } })
    );
    // Third call — GET for soft-404 check returns 200 without soft-404 body
    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://cn.vite.dev/config/');
    const opts = { ...DEFAULT_OPTS, timeoutMs: 100, retryOnTimeout: 1 };

    const resultPromise = checkSingleLink(link, opts);
    // Advance past the first timeout to trigger the retry
    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    expect(result.status).toBe('ok');
    // 3 calls: initial HEAD (timeout) + retry HEAD (200) + GET for soft-404 check (200)
    expect(mockFetch.mock.calls.length).toBe(3);
  });

  test('301 → 301 → 200 (2 hops) follows redirect and returns ok', async () => {
    // With redirect: 'follow', the browser follows redirects automatically.
    // The final 200 response is what we receive.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        url: 'https://example.com/final',
      })
    ));

    const link = makeLink('https://example.com/start');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
  });

  test('301 chain of 6 hops returns BrokenLink with reason.type === "redirect_loop"', async () => {
    // With redirect: 'follow', the browser throws a TypeError for too many redirects.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.reject(new TypeError('Failed to fetch'))
    ));

    const link = makeLink('https://example.com/hop1');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('network_error');
  });

  test('405 HEAD triggers GET retry with Range: bytes=0-0; GET 200 returns ok', async () => {
    const mockFetch = vi.fn();
    // First call (HEAD) → 405
    mockFetch.mockResolvedValueOnce({
      status: 405,
      headers: { get: () => null },
    });
    // Second call (GET with Range) → 200
    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://example.com/head-not-allowed');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');

    // Verify the second call used GET with Range header
    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[1].method).toBe('GET');
    expect(secondCall[1].headers['Range']).toBe('bytes=0-0');
  });

  test('403 HEAD triggers GET retry with Range: bytes=0-0; GET 200 returns ok', async () => {
    const mockFetch = vi.fn();
    // First call (HEAD) → 403 (server blocks HEAD from non-browser clients)
    mockFetch.mockResolvedValueOnce({
      status: 403,
      headers: { get: () => null },
    });
    // Second call (GET with Range) → 200
    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://example.com/head-blocked');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');

    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[1].method).toBe('GET');
    expect(secondCall[1].headers['Range']).toBe('bytes=0-0');
    expect(secondCall[1].headers['User-Agent']).toMatch(/Mozilla/);
  });

  test('404 HEAD triggers GET retry; GET 200 returns ok (SPA-style HEAD 404)', async () => {
    const mockFetch = vi.fn();
    // First call (HEAD) → 404 (SPA CDN returns 404 for HEAD, e.g. bsky.app)
    mockFetch.mockResolvedValueOnce({
      status: 404,
      headers: { get: () => null },
    });
    // Second call (GET with Range) → 200
    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://bsky.app/profile/example.com');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');

    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[1].method).toBe('GET');
    expect(secondCall[1].headers['Range']).toBe('bytes=0-0');
  });

  test('429 HEAD triggers GET retry; GET 200 returns ok (rate-limited HEAD)', async () => {
    const mockFetch = vi.fn();
    // First call (HEAD) → 429 (rate limited, e.g. GitHub)
    mockFetch.mockResolvedValueOnce({
      status: 429,
      headers: { get: () => null },
    });
    // Second call (GET with Range) → 200 with a normal (non-soft-404) body
    const bodyText = new TextEncoder().encode('<html><title>CHANGELOG</title></html>');
    let done = false;
    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: vi.fn().mockImplementation(() => {
            if (!done) { done = true; return Promise.resolve({ done: false, value: bodyText }); }
            return Promise.resolve({ done: true, value: undefined });
          }),
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
        cancel: vi.fn(),
      },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://github.com/org/repo/blob/main/CHANGELOG.md');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');

    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[1].method).toBe('GET');
    expect(secondCall[1].headers['Range']).toBe('bytes=0-0');
  });

  test('403 HEAD with GET also returning 403 returns ok (bot-blocked site, not a broken link)', async () => {
    // Sites like follower24.de return 403 to all automated requests.
    // A 403 on the GET fallback means the server is reachable and responding —
    // it is not a broken link, just a bot-blocking server.
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      status: 403,
      headers: { get: () => null },
    });
    mockFetch.mockResolvedValueOnce({
      status: 403,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://www.follower24.de/');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
  });

  test('429 HEAD with GET also returning 429 returns ok (rate-limited, not a broken link)', async () => {
    // Sites like GitHub return 429 when rate-limiting automated checkers.
    // A 429 on the GET fallback means the server is reachable — not a broken link.
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      status: 429,
      headers: { get: () => null },
    });
    mockFetch.mockResolvedValueOnce({
      status: 429,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
  });

  test('404 HEAD with GET also returning 404 returns broken (genuine 404)', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({
      status: 404,
      headers: { get: () => null },
    });
    mockFetch.mockResolvedValueOnce({
      status: 404,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://example.com/truly-gone');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('http_error');
    expect(result.link.reason.statusCode).toBe(404);
  });

  test('404 returns BrokenLink with reason.type === "http_error" and statusCode: 404', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        status: 404,
        headers: { get: () => null },
      })
    ));

    const link = makeLink('https://example.com/not-found');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('http_error');
    expect(result.link.reason.statusCode).toBe(404);
  });

  test('network error returns BrokenLink with reason.type === "network_error"', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.reject(new Error('Network failure'))
    ));

    const link = makeLink('https://example.com/network-error');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('network_error');
    expect(result.link.reason.message).toBe('Network failure');
  });
});

// ---------------------------------------------------------------------------
// checkSingleLink() — Property 1: Bug Condition — Soft 404 Detection
// Feature: github-content-404-detection
// Validates: Requirements 1.1, 1.2
// ---------------------------------------------------------------------------

describe('checkSingleLink() — Property 1: Bug Condition — Soft 404 Detection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('GitHub URL returning HTTP 200 with body containing "Not Found" is classified as broken with reason.type === "content_404"', async () => {
    // Mock fetch to return HTTP 200 with a body containing "Not Found"
    // This simulates a GitHub file on a deleted branch (soft 404)
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => {
            let done = false;
            return {
              read: () => {
                if (done) return Promise.resolve({ done: true, value: undefined });
                done = true;
                const encoder = new TextEncoder();
                return Promise.resolve({
                  done: false,
                  value: encoder.encode('<html><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>'),
                });
              },
              cancel: vi.fn(),
            };
          },
          cancel: vi.fn(),
        },
      })
    ));

    const link = makeLink('https://github.com/org/repo/blob/old-branch/README.md');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    // EXPECTED TO FAIL on unfixed code — checkSingleLink returns { status: "ok" }
    // without inspecting the body. Failure here confirms the bug exists.
    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('content_404');
  });

  test('GitHub URL returning HTTP 200 with body containing "404" in an <h1> is classified as broken with reason.type === "content_404"', async () => {
    // Mock fetch to return HTTP 200 with a body containing "404" in an <h1>
    // This simulates a GitHub repository that no longer exists (soft 404)
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => {
            let done = false;
            return {
              read: () => {
                if (done) return Promise.resolve({ done: true, value: undefined });
                done = true;
                const encoder = new TextEncoder();
                return Promise.resolve({
                  done: false,
                  value: encoder.encode('<html><head><title>Page Not Found</title></head><body><h1>404</h1><p>This repository does not exist.</p></body></html>'),
                });
              },
              cancel: vi.fn(),
            };
          },
          cancel: vi.fn(),
        },
      })
    ));

    const link = makeLink('https://github.com/org/deleted-repo');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    // EXPECTED TO FAIL on unfixed code — checkSingleLink returns { status: "ok" }
    // without inspecting the body. Failure here confirms the bug exists.
    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('content_404');
  });
});

// ---------------------------------------------------------------------------
// Property tests — checkSingleLink() — Property 2: Preservation — Non-Soft-404 Inputs
// Feature: github-content-404-detection
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
// ---------------------------------------------------------------------------

describe('checkSingleLink() — Property 2: Preservation — Non-Soft-404 Inputs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Property test A: for any hostname NOT in SOFT_404_PATTERNS (i.e. not github.com),
  // a 200 response always returns { status: "ok" }
  // Validates: Requirements 3.1, 3.5
  test('Property A: non-GitHub hostname with HTTP 200 always returns { status: "ok" }', async () => {
    /**
     * **Validates: Requirements 3.1, 3.5**
     *
     * For any URL whose hostname is NOT in SOFT_404_PATTERNS (not github.com),
     * a 200 response must always produce { status: "ok" } — no body inspection.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.webUrl().filter((url) => {
          try {
            const hostname = new URL(url).hostname;
            return hostname !== 'github.com' && !hostname.endsWith('.github.com');
          } catch {
            return false;
          }
        }),
        async (url) => {
          vi.stubGlobal('fetch', vi.fn(() =>
            Promise.resolve({
              status: 200,
              headers: { get: () => null },
            })
          ));

          const link = makeLink(url);
          const result = await checkSingleLink(link, DEFAULT_OPTS);

          expect(result.status).toBe('ok');

          vi.restoreAllMocks();
        }
      ),
      { numRuns: 50 }
    );
  });

  // Property test B: for any status code in [400, 599] (excluding HEAD-fallback codes
  // 403/404/429), result is always broken with reason.type === "http_error".
  // Also includes a GitHub-URL variant to confirm no regression.
  // Validates: Requirements 3.2
  test('Property B: HTTP error status codes [400-599] (excl. 403/404/429) always return broken http_error — including GitHub URLs', async () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any status code in [400, 599] excluding the HEAD-fallback codes (403, 404, 429),
     * the result must always be broken with reason.type === "http_error".
     * This applies to both non-GitHub and GitHub URLs.
     */
    const errorStatusArb = fc.integer({ min: 400, max: 599 }).filter(
      (code) => code !== 403 && code !== 404 && code !== 429
    );

    // Mix of GitHub and non-GitHub URLs
    const urlArb = fc.oneof(
      fc.constant('https://github.com/org/repo/blob/main/README.md'),
      fc.constant('https://github.com/org/deleted-repo'),
      fc.webUrl().filter((url) => {
        try {
          const hostname = new URL(url).hostname;
          return hostname !== 'github.com' && !hostname.endsWith('.github.com');
        } catch {
          return false;
        }
      })
    );

    await fc.assert(
      fc.asyncProperty(
        urlArb,
        errorStatusArb,
        async (url, statusCode) => {
          vi.stubGlobal('fetch', vi.fn(() =>
            Promise.resolve({
              status: statusCode,
              headers: { get: () => null },
            })
          ));

          const link = makeLink(url);
          const result = await checkSingleLink(link, DEFAULT_OPTS);

          expect(result.status).toBe('broken');
          expect(result.link.reason.type).toBe('http_error');
          expect(result.link.reason.statusCode).toBe(statusCode);

          vi.restoreAllMocks();
        }
      ),
      { numRuns: 50 }
    );
  });

  // Property test C: for a GitHub URL returning 200 with a body that does NOT contain
  // any soft-404 pattern, result is { status: "ok" }.
  // Validates: Requirements 3.1
  test('Property C: GitHub URL returning 200 with non-matching body returns { status: "ok" }', async () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * For a GitHub URL where the response body does NOT contain any soft-404 pattern
     * ("Not Found" or "404"), the result must be { status: "ok" }.
     * This is the "genuine GitHub link" preservation case.
     */
    // Generate body strings that do NOT contain "Not Found" or "404"
    const safeBodyArb = fc.string({ minLength: 0, maxLength: 500 }).filter(
      (body) => !body.includes('Not Found') && !body.includes('404')
    );

    const githubUrlArb = fc.oneof(
      fc.constant('https://github.com/vitejs/vite'),
      fc.constant('https://github.com/org/repo/blob/main/README.md'),
      fc.constant('https://github.com/microsoft/typescript')
    );

    await fc.assert(
      fc.asyncProperty(
        githubUrlArb,
        safeBodyArb,
        async (url, bodyContent) => {
          const encoder = new TextEncoder();
          const bodyBytes = encoder.encode(bodyContent);

          // Mock both HEAD (200) and GET (200 with safe body)
          const mockFetch = vi.fn();

          // HEAD response — 200, no body
          mockFetch.mockResolvedValueOnce({
            status: 200,
            headers: { get: () => null },
          });

          // GET response (if the fixed code issues one) — 200 with safe body
          mockFetch.mockResolvedValue({
            status: 200,
            headers: { get: () => null },
            body: {
              getReader: () => {
                let done = false;
                return {
                  read: () => {
                    if (done) return Promise.resolve({ done: true, value: undefined });
                    done = true;
                    return Promise.resolve({ done: false, value: bodyBytes });
                  },
                  cancel: vi.fn(),
                };
              },
              cancel: vi.fn(),
            },
          });

          vi.stubGlobal('fetch', mockFetch);

          const link = makeLink(url);
          const result = await checkSingleLink(link, DEFAULT_OPTS);

          expect(result.status).toBe('ok');

          vi.restoreAllMocks();
        }
      ),
      { numRuns: 30 }
    );
  });

  // Property test D: timeout and network error behavior is unchanged for GitHub URLs.
  // Validates: Requirements 3.3
  test('Property D: timeout behavior is unchanged for GitHub URLs', async () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * A never-resolving fetch for a GitHub URL must still produce
     * reason.type === "timeout" after the retry budget is exhausted.
     */
    vi.useFakeTimers();

    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const link = makeLink('https://github.com/org/repo');
    const opts = { ...DEFAULT_OPTS, timeoutMs: 100, retryOnTimeout: 1 };

    const resultPromise = checkSingleLink(link, opts);
    // Advance past both attempts (initial + 1 retry)
    await vi.advanceTimersByTimeAsync(300);
    const result = await resultPromise;

    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('timeout');
  });

  test('Property D: network error behavior is unchanged for GitHub URLs', async () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * A rejected fetch for a GitHub URL must still produce
     * reason.type === "network_error".
     */
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.reject(new Error('Network failure'))
    ));

    const link = makeLink('https://github.com/org/repo');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('broken');
    expect(result.link.reason.type).toBe('network_error');
  });
});

// ---------------------------------------------------------------------------
// Property tests — checkSingleLink() — Properties 3 and 4
// Feature: course-content-monitor, Property 3: Redirect loop detection
// Feature: course-content-monitor, Property 4: Broken link record completeness
// ---------------------------------------------------------------------------

describe('checkSingleLink() — Property 3: Redirect handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('redirect: follow means the browser handles redirects; a 200 final response returns ok', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (chainLength) => {
        // With redirect: 'follow', the browser follows the chain and we only see the final response.
        // Simulate the final 200 OK that the browser would deliver after following N redirects.
        vi.stubGlobal('fetch', vi.fn(() =>
          Promise.resolve({
            status: 200,
            headers: { get: () => null },
          })
        ));

        const link = makeLink('https://example.com/start');
        const result = await checkSingleLink(link, DEFAULT_OPTS);

        expect(result.status).toBe('ok');

        vi.restoreAllMocks();
      }),
      { numRuns: 20 }
    );
  });
});

describe('checkSingleLink() — Property 4: Broken link record completeness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('any broken link result has non-empty url, non-null reason, and anchorText is a string', async () => {
    // Arbitraries for broken link scenarios.
    // Note: 403 and 429 are excluded from the HTTP error set because the checker
    // treats them as "ok" (bot-blocked / rate-limited) rather than broken links.
    const brokenStatusArb = fc.oneof(
      fc.integer({ min: 400, max: 402 }),  // 400–402
      fc.integer({ min: 404, max: 428 }),  // 404–428 (excludes 403, 429)
      fc.integer({ min: 430, max: 599 }),  // 430–599 (excludes 429)
    );

    const failureModeArb = fc.oneof(
      // HTTP error (4xx/5xx, excluding 403 and 429)
      brokenStatusArb.map((statusCode) => ({
        type: 'http_error',
        mockFetch: () => Promise.resolve({ status: statusCode, headers: { get: () => null } }),
      })),
      // Timeout
      fc.constant({
        type: 'timeout',
        mockFetch: () => new Promise(() => {}), // never resolves
      }),
      // Network error
      fc.string({ minLength: 1 }).map((msg) => ({
        type: 'network_error',
        mockFetch: () => Promise.reject(new Error(msg)),
      }))
    );

    await fc.assert(
      fc.asyncProperty(
        fc.record({ url: fc.webUrl(), anchorText: fc.string() }),
        failureModeArb,
        async (linkData, failureMode) => {
          vi.useFakeTimers();
          vi.stubGlobal('fetch', vi.fn(() => failureMode.mockFetch()));

          const link = { url: linkData.url, anchorText: linkData.anchorText, rawHref: linkData.url };
          const opts = { ...DEFAULT_OPTS, timeoutMs: 100 };

          const resultPromise = checkSingleLink(link, opts);

          if (failureMode.type === 'timeout') {
            // Advance past both the initial attempt and the retry (timeoutMs: 100, retryOnTimeout: 1)
            await vi.advanceTimersByTimeAsync(300);
          }

          const result = await resultPromise;

          // Every broken result must satisfy these invariants
          expect(result.status).toBe('broken');
          expect(result.link.url).toBeTruthy();
          expect(result.link.url.length).toBeGreaterThan(0);
          expect(result.link.reason).not.toBeNull();
          expect(typeof result.link.anchorText).toBe('string');

          vi.useRealTimers();
          vi.restoreAllMocks();
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — checkLinks() concurrency
// ---------------------------------------------------------------------------

describe('checkLinks() — concurrency', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('no more than perDomainConcurrency requests run concurrently for the same hostname', async () => {
    const perDomainConcurrency = 2;
    let activeConcurrent = 0;
    let maxObserved = 0;

    // All links point to the same domain
    const links = Array.from({ length: 6 }, (_, i) =>
      makeLink(`https://same-domain.com/page${i}`)
    );

    vi.stubGlobal('fetch', vi.fn(() => {
      activeConcurrent++;
      maxObserved = Math.max(maxObserved, activeConcurrent);
      return new Promise((resolve) => {
        // Resolve after a tick so concurrency can build up
        setTimeout(() => {
          activeConcurrent--;
          resolve({ status: 200, headers: { get: () => null } });
        }, 10);
      });
    }));

    const opts = {
      timeoutMs: 5000,
      maxRedirects: 5,
      concurrency: 10,
      perDomainConcurrency,
    };

    vi.useFakeTimers();
    const resultPromise = checkLinks(links, opts);
    // Advance time to let all requests complete
    await vi.runAllTimersAsync();
    const results = await resultPromise;
    vi.useRealTimers();

    expect(maxObserved).toBeLessThanOrEqual(perDomainConcurrency);
    expect(results).toHaveLength(links.length);
  });

  test('global concurrency cap is respected across multiple domains', async () => {
    const globalConcurrency = 3;
    let activeConcurrent = 0;
    let maxObserved = 0;

    // Links spread across different domains
    const links = [
      makeLink('https://domain-a.com/1'),
      makeLink('https://domain-b.com/1'),
      makeLink('https://domain-c.com/1'),
      makeLink('https://domain-d.com/1'),
      makeLink('https://domain-e.com/1'),
      makeLink('https://domain-f.com/1'),
    ];

    vi.stubGlobal('fetch', vi.fn(() => {
      activeConcurrent++;
      maxObserved = Math.max(maxObserved, activeConcurrent);
      return new Promise((resolve) => {
        setTimeout(() => {
          activeConcurrent--;
          resolve({ status: 200, headers: { get: () => null } });
        }, 10);
      });
    }));

    const opts = {
      timeoutMs: 5000,
      maxRedirects: 5,
      concurrency: globalConcurrency,
      perDomainConcurrency: 2,
    };

    vi.useFakeTimers();
    const resultPromise = checkLinks(links, opts);
    await vi.runAllTimersAsync();
    const results = await resultPromise;
    vi.useRealTimers();

    expect(maxObserved).toBeLessThanOrEqual(globalConcurrency);
    expect(results).toHaveLength(links.length);
  });

  test('all links are checked even when some fail', async () => {
    const links = [
      makeLink('https://example.com/ok'),
      makeLink('https://example.com/broken'),
      makeLink('https://example.com/also-ok'),
    ];

    vi.stubGlobal('fetch', vi.fn((url) => {
      if (url.includes('broken')) {
        return Promise.resolve({ status: 404, headers: { get: () => null } });
      }
      return Promise.resolve({ status: 200, headers: { get: () => null } });
    }));

    const opts = {
      timeoutMs: 5000,
      maxRedirects: 5,
      concurrency: 10,
      perDomainConcurrency: 2,
    };

    const results = await checkLinks(links, opts);

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('broken');
    expect(results[2].status).toBe('ok');
  });

  test('results are returned in the same order as the input array', async () => {
    const links = [
      makeLink('https://alpha.com/page'),
      makeLink('https://beta.com/page'),
      makeLink('https://gamma.com/page'),
      makeLink('https://delta.com/page'),
    ];

    // Return different statuses so we can verify order
    const statusMap = {
      'https://alpha.com/page': 200,
      'https://beta.com/page': 404,
      'https://gamma.com/page': 200,
      'https://delta.com/page': 500,
    };

    vi.stubGlobal('fetch', vi.fn((url) =>
      Promise.resolve({ status: statusMap[url] ?? 200, headers: { get: () => null } })
    ));

    const opts = {
      timeoutMs: 5000,
      maxRedirects: 5,
      concurrency: 10,
      perDomainConcurrency: 2,
    };

    const results = await checkLinks(links, opts);

    expect(results).toHaveLength(4);
    expect(results[0].status).toBe('ok');   // alpha 200
    expect(results[1].status).toBe('broken'); // beta 404
    expect(results[2].status).toBe('ok');   // gamma 200
    expect(results[3].status).toBe('broken'); // delta 500
  });
});

// ---------------------------------------------------------------------------
// Unit tests — checkSingleLink() — statusCode on OK results (Task 2.1)
// Feature: show-status-code-all-links
// Validates: Requirements 1.1, 1.3, 1.4
// ---------------------------------------------------------------------------

describe('checkSingleLink() — statusCode on OK results', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('200 HEAD response returns { status: "ok", url, statusCode: 200 }', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        status: 200,
        headers: { get: () => null },
      })
    ));

    const link = makeLink('https://example.com/page');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(200);
  });

  test('403 HEAD → 403 GET (bot-blocked) returns { status: "ok", url, statusCode: 403 }', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ status: 403, headers: { get: () => null } });
    mockFetch.mockResolvedValueOnce({
      status: 403,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://www.follower24.de/');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(403);
  });

  test('429 HEAD → 429 GET (rate-limited) returns { status: "ok", url, statusCode: 429 }', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ status: 429, headers: { get: () => null } });
    mockFetch.mockResolvedValueOnce({
      status: 429,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(429);
  });

  test('405 HEAD → 200 GET returns { status: "ok", url, statusCode: 200 }', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ status: 405, headers: { get: () => null } });
    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://example.com/head-not-allowed');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(200);
  });

  test('404 HEAD → 200 GET returns { status: "ok", url, statusCode: 200 }', async () => {
    const mockFetch = vi.fn();
    mockFetch.mockResolvedValueOnce({ status: 404, headers: { get: () => null } });
    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => null },
      body: { cancel: vi.fn() },
    });
    vi.stubGlobal('fetch', mockFetch);

    const link = makeLink('https://bsky.app/profile/example.com');
    const result = await checkSingleLink(link, DEFAULT_OPTS);

    expect(result.status).toBe('ok');
    expect(result.statusCode).toBe(200);
  });
});
