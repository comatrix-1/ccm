/**
 * Vercel serverless proxy for OpenRouter API calls.
 * Helper sub-components — main handler is in Task 2.2.
 */

/**
 * Extracts the client IP address from the request.
 * Prefers the first IP in x-forwarded-for, falls back to socket address.
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? '';
}

/**
 * Sets CORS headers on the response.
 * @param {import('http').ServerResponse} res
 */
export function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.EXTENSION_ORIGIN ?? '');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

/**
 * Validates the proxy request body.
 * @param {unknown} body
 * @returns {string | null} Error message string, or null if valid.
 */
export function validateRequest(body) {
  if (!body?.model) {
    return 'Missing required field: model';
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'Missing required field: messages (must be a non-empty array)';
  }
  return null;
}

/**
 * @typedef {Object} RateLimitEntry
 * @property {number} count       - number of requests in the current window
 * @property {number} windowStart - Unix timestamp (ms) when the window opened
 */

/**
 * In-memory rate limiter keyed by client IP.
 * Tracks a fixed window of WINDOW_MS milliseconds with a MAX_REQUESTS cap.
 */
export class RateLimiter {
  static WINDOW_MS = 60_000;
  static MAX_REQUESTS = 5;

  constructor() {
    /** @type {Map<string, RateLimitEntry>} */
    this.store = new Map();
  }

  /**
   * Checks whether the given IP is within its rate limit and increments the counter.
   * @param {string} ip
   * @returns {{ allowed: true } | { allowed: false, retryAfter: number }}
   */
  checkAndIncrement(ip) {
    const now = Date.now();
    let entry = this.store.get(ip);

    if (!entry) {
      entry = { count: 0, windowStart: now };
      this.store.set(ip, entry);
    }

    // Reset window if it has expired
    if (now - entry.windowStart >= RateLimiter.WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }

    if (entry.count >= RateLimiter.MAX_REQUESTS) {
      const retryAfter = Math.ceil(
        (entry.windowStart + RateLimiter.WINDOW_MS - now) / 1000
      );
      return { allowed: false, retryAfter };
    }

    entry.count += 1;
    return { allowed: true };
  }
}

/**
 * Structured logger — emits a JSON line to stdout.
 * @param {string} event - Short event name (e.g. "llm_input", "llm_output").
 * @param {Record<string, unknown>} data - Arbitrary key/value pairs to log.
 */
export function log(event, data) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

/**
 * Forwards the request body to the OpenRouter chat completions endpoint.
 * Logs the LLM input before the call and the LLM output after.
 * @param {unknown} body - The parsed request body to forward.
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function forwardToOpenRouter(body) {
  // Log what we are sending to the LLM
  log('llm_input', {
    model: body?.model,
    message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
    messages: body?.messages,
  });

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();

    // Log the raw response text immediately so it's visible even if JSON.parse fails
    log('llm_raw_output', { status: response.status, raw: responseText });

    // Log what the LLM returned
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseText);
    } catch (parseErr) {
      log('llm_parse_error', { message: parseErr?.message, raw: responseText });
      parsedResponse = responseText;
    }

    log('llm_output', {
      status: response.status,
      model: parsedResponse?.model,
      usage: parsedResponse?.usage,
      finish_reason: parsedResponse?.choices?.[0]?.finish_reason,
      response_content: parsedResponse?.choices?.[0]?.message?.content,
      error: parsedResponse?.error,
    });

    return { status: response.status, body: responseText };
  } catch (err) {
    log('llm_error', { message: err?.message ?? String(err) });
    return {
      status: 502,
      body: JSON.stringify({ error: 'Upstream request failed' }),
    };
  }
}

/** Module-level rate limiter instance shared across warm invocations. */
export const rateLimiter = new RateLimiter();

/**
 * Main Vercel serverless handler for the semantic-check proxy endpoint.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export default async function handler(req, res) {
  // 0. Log incoming request
  log('request', { method: req.method, url: req.url, ip: getClientIp(req) });

  // 1. Check env vars — return 503 if either is missing
  if (!process.env.OPENROUTER_API_KEY || !process.env.EXTENSION_ORIGIN) {
    res.setHeader('Content-Type', 'application/json');
    res.status(503).json({ error: 'Proxy not configured' });
    return;
  }

  // 2. Set CORS headers on every response
  setCorsHeaders(res);

  // 3. Handle OPTIONS preflight — return 200 with empty body
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 4. Reject non-POST methods with 405
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // 5. Parse JSON body — return 400 on parse failure
  let body;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(raw);
  } catch {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  // 6. Validate request — return 400 with error message on failure
  const validationError = validateRequest(body);
  if (validationError) {
    res.setHeader('Content-Type', 'application/json');
    res.status(400).json({ error: validationError });
    return;
  }

  // 7. Rate limit check — return 429 with Retry-After header on denial
  const clientIp = getClientIp(req);
  const rateResult = rateLimiter.checkAndIncrement(clientIp);
  if (!rateResult.allowed) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Retry-After', String(rateResult.retryAfter));
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  // 8. Forward to OpenRouter — pass upstream status and body through
  res.setHeader('Content-Type', 'application/json');
  const upstream = await forwardToOpenRouter(body);
  res.status(upstream.status).end(upstream.body);
}
