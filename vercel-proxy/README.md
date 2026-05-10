# vercel-proxy

Serverless Vercel proxy that forwards OpenRouter API calls on behalf of the Course Content Monitor Chrome extension. Users without their own OpenRouter API key can use the semantic check feature via this shared proxy.

## Environment Variables

Set these in the Vercel dashboard under **Project → Settings → Environment Variables**.

| Variable             | Description                                                                                                                           | Example                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `OPENROUTER_API_KEY` | The OpenRouter API key used as the Bearer token when forwarding requests to the OpenRouter API. This key is never exposed to clients. | `sk-or-v1-...`                         |
| `EXTENSION_ORIGIN`   | The Chrome extension origin used for the `Access-Control-Allow-Origin` CORS header. Must match the extension's origin exactly.        | `chrome-extension://your-extension-id` |

## Deployment

### Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Vercel CLI](https://vercel.com/docs/cli): `npm install -g vercel`

### Steps

1. From the `vercel-proxy/` directory, run:

   ```bash
   vercel deploy
   ```

2. Follow the prompts to link or create a Vercel project.

3. After deployment, open the Vercel dashboard and set the required environment variables (`OPENROUTER_API_KEY` and `EXTENSION_ORIGIN`) under **Project → Settings → Environment Variables**.

4. Redeploy (or promote to production) after setting the environment variables:

   ```bash
   vercel deploy --prod
   ```

5. Copy the production deployment URL and set it as `VITE_PROXY_URL` in the extension's `.env.production` file:

   ```
   VITE_PROXY_URL=https://your-project.vercel.app/api/semantic-check
   ```

## Rate-Limiting Policy

The proxy enforces a **5 requests per 60-second rolling window** limit per client IP address.

- Client IP is determined from the `x-forwarded-for` header (set by Vercel's edge network), falling back to the socket remote address if the header is absent.
- When the limit is exceeded, the proxy returns **HTTP 429** with a `Retry-After` header indicating the number of seconds until the current window resets.
- The extension surfaces this as: _"Semantic check rate limit reached — please wait a moment and try again."_

The rate limiter is in-memory and resets on cold starts. It is a best-effort abuse guard, not a hard quota.

## Endpoint

`POST /api/semantic-check`

**Request body** (JSON):

```json
{
  "model": "string",
  "messages": [{ "role": "user", "content": "..." }],
  "response_format": { "type": "json_object" }
}
```

**Success response**: HTTP 200 with the OpenRouter API response body passed through unchanged.

**Error responses**:

| Condition              | Status          | Body                                                        |
| ---------------------- | --------------- | ----------------------------------------------------------- |
| Missing env vars       | 503             | `{ "error": "Proxy not configured" }`                       |
| Non-POST method        | 405             | `{ "error": "Method not allowed" }`                         |
| Invalid JSON body      | 400             | `{ "error": "Invalid JSON body" }`                          |
| Missing/invalid fields | 400             | `{ "error": "..." }`                                        |
| Rate limit exceeded    | 429             | `{ "error": "Rate limit exceeded" }` + `Retry-After` header |
| OpenRouter error       | upstream status | `{ "error": "Upstream error: HTTP <status>" }`              |
