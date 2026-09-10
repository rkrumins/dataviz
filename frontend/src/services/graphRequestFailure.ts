/**
 * graphRequestFailure — ONE reading of a failed graph request, shared by the
 * request layer (what the circuit breaker counts, what is retried) and the
 * canvas hydration (what the overlay says).
 *
 * The canvas used to treat every failure that was not the literal string
 * `PROVIDER_LOADING` as "the graph provider is unavailable": a 504 from a slow
 * query, a 429 from the backend shedding a hydration burst, a 401 from an
 * access token that had just expired, a client-side timeout on a slow
 * connection. Each rendered "Graph service is unavailable" over a FalkorDB
 * that was serving fine, and three of them opened the client breaker so the
 * next reads never left the browser. Only a page reload (fresh breaker
 * registry) cleared it — the "refreshing sometimes fixes it" symptom.
 *
 * Three kinds:
 *  - `warming`     — the backend said the provider is loading its dataset
 *                    (503 + `PROVIDER_LOADING`). Transient, keep polling fast.
 *  - `unavailable` — the backend CONFIRMED the provider is unreachable (503 +
 *                    `PROVIDER_UNAVAILABLE`: breaker open, preflight down), or
 *                    the browser could not reach the backend at all. The only
 *                    kind that counts toward the client circuit breaker.
 *  - `transient`   — everything else from the network: a slow request (504,
 *                    client timeout), load shedding (429), a gateway hiccup
 *                    (502), a rejected query (500), or a session/CSRF problem
 *                    the fetch layer repairs on its own (401/403). Never an
 *                    outage.
 *  - `error`       — not from the network at all: a `TypeError`, `RangeError`,
 *                    `ReferenceError` or `SyntaxError` thrown by code while the
 *                    load ran (a UI library reading a property of `undefined`,
 *                    a body that was not JSON). A bug, not a provider state —
 *                    it must never be rendered as an outage, never feed the
 *                    breaker, and never hide behind "taking longer than usual".
 */

export interface ApiStatusError extends Error {
  status: number
  /** Structured code from the backend's `{detail: {code | error}}` envelope. */
  code?: string
  /** The server's `Retry-After`, in milliseconds, when it sent one. */
  retryAfterMs?: number
}

export type GraphFailureKind = 'warming' | 'unavailable' | 'transient' | 'error'

export function isApiStatusError(err: unknown): err is ApiStatusError {
  return err instanceof Error && typeof (err as Partial<ApiStatusError>).status === 'number'
}

/** The HTTP status behind a rejection, or null when it did not come from
 *  one (an abort, a timeout, a parse failure). */
export function httpStatusOf(err: unknown): number | null {
  return isApiStatusError(err) ? err.status : null
}

/** A `fetch` rejection: the request never got an HTTP answer at all. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('failed to fetch')
    || msg.includes('networkerror')
    || msg.includes('network request failed')
    || msg.includes('load failed')
  )
}

/** `fetchWithTimeout`'s own deadline (or its `Request timed out:` rewrap). */
export function isClientTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.toLowerCase().includes('timed out')
}

/** An engine error thrown by code, not a failed request: `fetch` rejects
 *  with a `TypeError` too, so its own messages are ruled out first. */
export function isApplicationError(err: unknown): boolean {
  if (isApiStatusError(err) || isNetworkError(err) || isClientTimeout(err)) return false
  return (
    err instanceof TypeError
    || err instanceof RangeError
    || err instanceof ReferenceError
    || err instanceof SyntaxError
  )
}

/** Build the error a non-OK response becomes. Keeps the legacy
 *  `API Error <status>: <body>` message (callers match on it) and attaches
 *  the structured code + Retry-After so classification never has to parse
 *  prose. */
export function toApiStatusError(response: Response, bodyText: string): ApiStatusError {
  const error: ApiStatusError = Object.assign(
    new Error(`API Error ${response.status}: ${bodyText || response.statusText}`),
    { status: response.status },
  )
  const code = extractCode(bodyText)
  if (code) error.code = code
  const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'))
  if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs
  return error
}

function extractCode(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { detail?: unknown; code?: unknown }
    const detail = parsed.detail
    if (detail && typeof detail === 'object') {
      const d = detail as { code?: unknown; error?: unknown }
      if (typeof d.code === 'string') return d.code
      if (typeof d.error === 'string') return d.error
    }
    if (typeof parsed.code === 'string') return parsed.code
  } catch {
    // Not JSON (an nginx HTML error page) — no code.
  }
  return undefined
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
  const at = Date.parse(header)
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now())
  return null
}

export function classifyGraphFailure(err: unknown): GraphFailureKind {
  const message = err instanceof Error ? err.message : String(err ?? '')
  const code = isApiStatusError(err) ? err.code : undefined
  if (code === 'PROVIDER_LOADING' || message.includes('PROVIDER_LOADING')) return 'warming'
  if (code === 'PROVIDER_UNAVAILABLE') return 'unavailable'
  // The client breaker's own rejection: it only opens on confirmed signals.
  if (message.includes('circuit open')) return 'unavailable'
  if (isNetworkError(err)) return 'unavailable'
  if (isApplicationError(err)) return 'error'
  return 'transient'
}

/** Should this failure count toward the client circuit breaker? Only a
 *  confirmed outage does — a slow or shed request must never open it. */
export function isProviderOutageSignal(err: unknown): boolean {
  if (isApiStatusError(err)) return err.code === 'PROVIDER_UNAVAILABLE'
  return isNetworkError(err)
}

/** How many extra attempts an idempotent graph read gets. */
export const MAX_READ_RETRIES = 2

/** Failures worth retrying in place, for an idempotent read: the backend
 *  asked for it (429 / 503 + Retry-After, a warming provider), a request
 *  simply ran out of time (504, client timeout — the backend's stale-fallback
 *  or cache often answers the retry), or a gateway hiccup (502, a dropped
 *  connection). A confirmed outage is NOT retried here — the breaker and the
 *  canvas' paced retry loop own that — and neither is a rejected query (500)
 *  or a session problem (401/403), which the fetch layer already replayed
 *  once after repairing it. */
export function isRetryableGraphFailure(err: unknown): boolean {
  if (isApiStatusError(err)) {
    if (err.status === 429 || err.status === 502 || err.status === 504) return true
    return err.status === 503 && err.code !== 'PROVIDER_UNAVAILABLE'
  }
  return isClientTimeout(err) || isNetworkError(err)
}

const RETRY_AFTER_CAP_MS = 5_000
const RETRY_BACKOFF_MS = [500, 1_500] as const

/** Wait before retry number `attempt` (0-based): the server's Retry-After
 *  when it sent one (capped so a 30s hint cannot stall a canvas), else a
 *  short backoff — always with jitter so a fleet of tabs does not retry in
 *  lockstep. */
export function retryDelayMs(err: unknown, attempt: number): number {
  const hinted = isApiStatusError(err) ? err.retryAfterMs : undefined
  const base = hinted !== undefined
    ? Math.min(RETRY_AFTER_CAP_MS, hinted)
    : RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]
  return base + Math.floor(Math.random() * 250)
}

/** Read-only POST endpoints under `/graph`. A POST that queries (nodes,
 *  edges, search, trace, assignments) is safe to replay; a POST that creates
 *  or mutates is not, whatever the failure. Matched on the path after the
 *  `/graph` segment. */
const READ_ONLY_POST_PATHS = [
  /^\/nodes\/query$/,
  /^\/nodes\/degree$/,
  /^\/edges\/query$/,
  /^\/edges\/between$/,
  /^\/edges\/aggregated$/,
  /^\/search(\/advanced|\/explain)?$/,
  /^\/trace(\/v2|\/closure|\/expand|\/expand-batch)?$/,
  /^\/assignments\/compute$/,
]

export function isIdempotentGraphRead(method: string, url: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return true
  if (m !== 'POST') return false
  const pathOnly = url.split('?')[0]
  const seg = pathOnly.replace(/^\/api\/v\d+(\/[^/]+)?\/graph/, '')
  return READ_ONLY_POST_PATHS.some(re => re.test(seg))
}
