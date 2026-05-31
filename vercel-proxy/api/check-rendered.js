/**
 * Vercel serverless endpoint for checking page content after JS hydration.
 * Uses Playwright to load the page, wait for JS to render, and check DOM content.
 */

import { chromium } from 'playwright';

/**
 * Soft-404 patterns to detect in the rendered DOM.
 * @type {string[]}
 */
const SOFT_404_PATTERNS = [
  'not found',
  '404',
  "doesn't look right",
  "can't find",
  "doesn't exist",
  'no longer available',
  'has been removed',
  'has been deleted',
  'is not found',
  'was not found',
  'page not found',
  'file not found',
  'resource not found',
  'content not found',
];

/**
 * Timeout for waiting for page to be fully loaded (ms).
 * @type {number}
 */
const PAGE_LOAD_TIMEOUT_MS = 30_000;

/**
 * Timeout for waiting for network to be idle (ms).
 * @type {number}
 */
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} CheckRenderedResult
 * @property {boolean} isSoft404
 * @property {string[]} matchedPatterns
 * @property {string} pageTitle
 * @property {string} pageUrl - Final URL after redirects
 * @property {string} bodyText - First 4096 chars of rendered body text
 */

/**
 * Checks if the given URL returns soft-404 content after JS hydration.
 *
 * @param {string} url - The URL to check
 * @returns {Promise<CheckRenderedResult>}
 */
export async function checkRenderedPage(url) {
  let browser = null;

  try {
    // Launch headless browser
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      // Set a realistic user agent
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Track final URL after any redirects
    let finalUrl = url;

    page.on('response', (response) => {
      if (response.url() !== finalUrl) {
        finalUrl = response.url();
      }
    });

    console.log(`[check-rendered] Navigating to ${url}`);

    // Navigate to the URL and wait for network to be idle
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });

    // Wait a bit more for any remaining JS to execute
    await page.waitForTimeout(2000);

    // Get page title
    const pageTitle = await page.title();

    // Get the full HTML content after rendering
    const bodyText = await page.evaluate(() => {
      // Try to get the main content area first
      const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
      return main.innerText || '';
    });

    // Truncate to first 4096 chars for pattern matching
    const truncatedBodyText = bodyText.substring(0, 4096).toLowerCase();

    // Check for soft-404 patterns
    const matchedPatterns = SOFT_404_PATTERNS.filter((pattern) =>
      truncatedBodyText.includes(pattern.toLowerCase())
    );

    const isSoft404 = matchedPatterns.length > 0;

    console.log(`[check-rendered] ${url} → isSoft404: ${isSoft404}, matchedPatterns: ${JSON.stringify(matchedPatterns)}, title: "${pageTitle}"`);

    return {
      isSoft404,
      matchedPatterns,
      pageTitle,
      pageUrl: finalUrl,
      bodyText: truncatedBodyText,
    };
  } catch (err) {
    console.error(`[check-rendered] Error checking ${url}: ${err.message}`);
    throw err;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * CORS headers helper.
 * @param {import('http').ServerResponse} res
 */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.EXTENSION_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * @typedef {Object} RateLimitEntry
 * @property {number} count
 * @property {number} windowStart
 */

/**
 * In-memory rate limiter.
 */
class RateLimiter {
  static WINDOW_MS = 60_000;
  static MAX_REQUESTS = 10;

  constructor() {
    /** @type {Map<string, RateLimitEntry>} */
    this.store = new Map();
  }

  checkAndIncrement(ip) {
    const now = Date.now();
    let entry = this.store.get(ip);

    if (!entry) {
      entry = { count: 0, windowStart: now };
      this.store.set(ip, entry);
    }

    if (now - entry.windowStart >= RateLimiter.WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }

    if (entry.count >= RateLimiter.MAX_REQUESTS) {
      const retryAfter = Math.ceil((entry.windowStart + RateLimiter.WINDOW_MS - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count += 1;
    return { allowed: true };
  }
}

const rateLimiter = new RateLimiter();

/**
 * Extracts client IP from request.
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? '';
}

/**
 * Main handler.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  console.log('[check-rendered] Request:', req.method, req.url);

  // CORS
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Rate limit
  const clientIp = getClientIp(req);
  const rateResult = rateLimiter.checkAndIncrement(clientIp);
  if (!rateResult.allowed) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', String(rateResult.retryAfter));
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  // Parse body
  let body;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(raw);
  } catch {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  if (!body?.url || typeof body.url !== 'string') {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Missing required field: url' });
    return;
  }

  try {
    const result = await checkRenderedPage(body.url);

    res.setHeader('Content-Type', 'application/json');
    res.status(200).json(result);
  } catch (err) {
    console.error('[check-rendered] Error:', err.message);
    res.setHeader('Content-Type', 'application/json');
    res.status(502).json({
      error: 'Failed to check rendered page',
      message: err.message,
    });
  }
}