/**
 * Cache-only response envelope types and helpers.
 *
 * The backend's cache-only graph introspection endpoints
 * (`/graph/stats`, `/graph/metadata/schema`, `/introspection`,
 * `/metadata/ontology`, `/cached-schema`, `/cached-ontology`,
 * `/cached-stats`) return a canonical envelope:
 *
 *     { data: <payload-or-null>, meta: { status, source, ... } }
 *
 * with HTTP 200 always — state lives in `meta.status`. This module
 * provides:
 *
 * 1. Type definitions for the envelope and its `meta` block
 * 2. `unwrapEnvelope<T>()` — extract `data` (or null on error states)
 * 3. `isCacheEnvelope()` — type guard for endpoints that may or may
 *    not return envelopes (legacy mixed surface)
 * 4. `fetchEnveloped<T>()` — single-call fetch + parse + unwrap
 * 5. `fetchEnvelopedWithMeta<T>()` — same, but returns meta too
 *
 * Callers that need cache freshness for UI banners should use
 * `fetchEnvelopedWithMeta` (or call `unwrapEnvelopeWithMeta` directly).
 * Callers that just want the payload should use `fetchEnveloped`.
 *
 * **Anti-pattern to avoid:** calling `fetchWithTimeout` then
 * `await res.json()` and reading `data.someField` directly. The body
 * shape is `{data, meta}` — `someField` lives at `data.data.someField`.
 * Use the helpers below; they make the unwrap explicit at every site
 * and prevent the "everything shows as 0" failure mode that occurred
 * when consumers were left raw.
 */
import { getCircuitBreaker } from './circuitBreaker'
import { fetchWithTimeout } from './fetchWithTimeout'

export type CacheStatus = 'fresh' | 'stale' | 'computing' | 'partial' | 'error'
export type CacheSource = 'postgres' | 'ontology' | 'none' | 'error'
export type StatsServiceStatus =
    | 'healthy'
    | 'lagging'
    | 'unreachable'
    | 'unknown'

export interface CacheMeta {
    status: CacheStatus
    source: CacheSource
    age_seconds: number | null
    ttl_seconds: number | null
    missing_fields: string[]
    data_source_id: string
    stats_service_status: StatsServiceStatus
    provider_health: 'healthy' | 'unreachable' | 'unknown'
    refreshing: boolean
    job_id?: string
    poll_url?: string
    updated_at?: string
}

export interface CacheEnvelope<T> {
    data: T | null
    meta: CacheMeta
}

/**
 * Type guard: true if `x` is a `{data, meta}` envelope with the
 * required meta keys. Used at boundaries where a response could be
 * either an envelope or a legacy raw payload.
 */
export function isCacheEnvelope<T = unknown>(
    x: unknown,
): x is CacheEnvelope<T> {
    if (x === null || typeof x !== 'object') return false
    const obj = x as Record<string, unknown>
    if (!('data' in obj) || !('meta' in obj)) return false
    const meta = obj.meta
    if (meta === null || typeof meta !== 'object') return false
    const metaObj = meta as Record<string, unknown>
    return (
        'status' in metaObj &&
        'source' in metaObj &&
        'age_seconds' in metaObj &&
        'ttl_seconds' in metaObj &&
        'missing_fields' in metaObj
    )
}

/**
 * Extract `data` from an envelope. Returns `null` when the envelope
 * carries `meta.status === 'error'` so callers can branch cleanly.
 *
 * If the value is NOT an envelope (pre-refactor endpoint, dedicated
 * legacy surface), it's returned verbatim — this lets shared fetch
 * helpers be used uniformly across endpoints during the migration.
 */
export function unwrapEnvelope<T>(value: unknown): T | null {
    if (isCacheEnvelope<T>(value)) {
        if (value.meta.status === 'error') return null
        return value.data
    }
    return value as T
}

/**
 * Unwrap and return both data and meta. Use when the caller wants to
 * surface freshness/staleness state to the UI. Returns null for both
 * if the value is not an envelope.
 */
export function unwrapEnvelopeWithMeta<T>(
    value: unknown,
): { data: T | null; meta: CacheMeta | null } {
    if (isCacheEnvelope<T>(value)) {
        return { data: value.data, meta: value.meta }
    }
    return { data: value as T, meta: null }
}


/**
 * Options accepted by `fetchEnveloped` / `fetchEnvelopedWithMeta`.
 * Mirrors the resilience surface that `RemoteGraphProvider._doFetch`
 * already implements for graph endpoints, so cache-envelope endpoints
 * get the same fail-fast / Retry-After / circuit-breaker treatment.
 */
export interface FetchEnvelopedOptions {
    /** Forwarded to `fetchWithTimeout`. Default 5s comes from there. */
    timeoutMs?: number
    /** Standard fetch init (method, body, headers, signal, …). */
    init?: RequestInit
    /**
     * Circuit-breaker scope. When set, this call goes through the same
     * keyed breaker (`getCircuitBreaker(workspaceId, dataSourceId)`)
     * that `RemoteGraphProvider` uses — so a backend outage that's
     * already opened the circuit for graph queries also fails fast for
     * cache-envelope queries on the same scope, and vice versa.
     *
     * Default: an unscoped global breaker (`workspaceId='', dataSourceId=''`).
     * Pass an empty object `{}` to opt into the global breaker explicitly.
     */
    circuitScope?: { workspaceId?: string; dataSourceId?: string }
    /**
     * Disable the circuit breaker entirely for this call. Use only for
     * health-probes that shouldn't *contribute* to the breaker state
     * (e.g. an "is the cache populated yet?" poll).
     */
    useCircuitBreaker?: boolean
}


/**
 * Internal: run a single envelope fetch with full resilience.
 *
 * Returns the parsed JSON body (envelope-shaped or otherwise) for the
 * caller to unwrap, or `null` when:
 *   * the circuit is open (fail-fast — no network call),
 *   * the response is non-OK (counts as failure for the breaker on 5xx),
 *   * the request times out / hits a network error,
 *   * the body cannot be parsed as JSON.
 *
 * On 5xx with a `Retry-After` header, the breaker is opened with the
 * server-suggested delay so the frontend honors backpressure rather
 * than stampeding a recovering backend.
 *
 * Auth / 401 / CSRF / session-cookie behavior is inherited verbatim
 * from `fetchWithTimeout` — this helper does not add any auth logic.
 */
async function _runEnvelopeFetch(
    url: string,
    options?: FetchEnvelopedOptions,
): Promise<unknown | null> {
    const useCB = options?.useCircuitBreaker !== false
    const cb = useCB
        ? getCircuitBreaker(
              options?.circuitScope?.workspaceId,
              options?.circuitScope?.dataSourceId,
          )
        : null

    // Pre-flight: if the breaker is open, skip the network call entirely
    // so we don't burn the 5s timeout against a backend we already know
    // is dead. The half-open path is handled inside `canRequest()`.
    if (cb && !cb.canRequest()) return null

    let res: Response
    try {
        res = await fetchWithTimeout(url, {
            ...(options?.init ?? {}),
            timeoutMs: options?.timeoutMs,
        })
    } catch (err) {
        // `fetchWithTimeout` throws TypeError on timeout AND on network
        // failure. Either way it's a "backend unreachable" signal that
        // should feed the breaker — same policy as `_doFetch`.
        if (cb && err instanceof TypeError) {
            cb.recordFailure()
        }
        return null
    }

    if (!res.ok) {
        if (cb && res.status >= 500) {
            // Honor Retry-After (RFC 7231) on 503 so the breaker waits at
            // least as long as the backend asked. Mirror `_doFetch`.
            const retryAfterRaw = res.headers.get('Retry-After')
            const retryAfterMs = retryAfterRaw
                ? parseInt(retryAfterRaw, 10) * 1000
                : undefined
            cb.recordFailure(
                retryAfterMs !== undefined && !isNaN(retryAfterMs)
                    ? retryAfterMs
                    : undefined,
            )
        }
        // 4xx is a logical no-match (404 = data source missing, 401 = auth)
        // — don't penalize the breaker for those. The handler returns null
        // and the caller's `?? 0` fallback engages.
        return null
    }

    let json: unknown
    try {
        json = await res.json()
    } catch {
        // Malformed body — count as success at the breaker level (the
        // backend DID respond) but return null so the caller doesn't
        // crash on undefined fields.
        cb?.recordSuccess()
        return null
    }

    cb?.recordSuccess()
    return json
}


/**
 * Fetch + parse + unwrap a cache-envelope endpoint in one call.
 *
 * Returns the unwrapped `data` payload, or `null` if:
 *   * the circuit is open (fail-fast — no network call),
 *   * the response is non-OK (4xx/5xx),
 *   * `meta.status === "error"` in the envelope,
 *   * the body is malformed.
 *
 * For a cache-miss state (`meta.status === "computing"`), the backend
 * returns `data: null` — this helper passes that through. Callers see
 * `null` and should render their "loading" / "—" UI rather than
 * defaulting to zero counts implicitly.
 *
 * Consumers that need `meta` (UI banners, freshness chips, retry
 * decisions) should use {@link fetchEnvelopedWithMeta} instead.
 */
export async function fetchEnveloped<T>(
    url: string,
    options?: FetchEnvelopedOptions,
): Promise<T | null> {
    const json = await _runEnvelopeFetch(url, options)
    if (json === null) return null
    return unwrapEnvelope<T>(json)
}


/**
 * Fetch + parse + unwrap, returning both data and meta.
 *
 * Use when the caller renders a freshness banner, staleness chip, or
 * needs to drive retry behavior off `meta.status` /
 * `meta.stats_service_status` / `meta.provider_health`.
 *
 * Carries the same circuit-breaker / timeout / Retry-After resilience
 * as {@link fetchEnveloped}.
 */
export async function fetchEnvelopedWithMeta<T>(
    url: string,
    options?: FetchEnvelopedOptions,
): Promise<{ data: T | null; meta: CacheMeta | null }> {
    const json = await _runEnvelopeFetch(url, options)
    if (json === null) return { data: null, meta: null }
    return unwrapEnvelopeWithMeta<T>(json)
}
