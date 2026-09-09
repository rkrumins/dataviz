/**
 * graphRequestFailure — the one reading of a failed graph request.
 *
 * Pins the contract that fixes "Graph service is unavailable" over a healthy
 * FalkorDB: only a backend-confirmed outage is `unavailable` (and counts
 * toward the client breaker); a slow, shed, gateway or session failure is
 * `transient` and retried in place when the read is idempotent.
 */
import { describe, expect, it } from 'vitest'

import {
  classifyGraphFailure,
  isIdempotentGraphRead,
  isProviderOutageSignal,
  isRetryableGraphFailure,
  retryDelayMs,
  toApiStatusError,
} from '../graphRequestFailure'

function response(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    statusText: `HTTP ${status}`,
    headers: { get: (name: string) => headers[name] ?? null },
  } as unknown as Response
}

function apiError(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return toApiStatusError(response(status, headers), typeof body === 'string' ? body : JSON.stringify(body))
}

describe('toApiStatusError', () => {
  it('keeps the legacy message and attaches status, code and Retry-After', () => {
    const err = apiError(503, { detail: { code: 'PROVIDER_UNAVAILABLE', reason: 'circuit open' } }, { 'Retry-After': '28' })
    expect(err.message).toContain('API Error 503')
    expect(err.status).toBe(503)
    expect(err.code).toBe('PROVIDER_UNAVAILABLE')
    expect(err.retryAfterMs).toBe(28_000)
  })

  it('reads the auth envelope `detail.error` as the code', () => {
    expect(apiError(403, { detail: { error: 'csrf_failed' } }).code).toBe('csrf_failed')
  })

  it('tolerates a non-JSON body (an nginx HTML error page)', () => {
    const err = apiError(504, '<html>504 Gateway Time-out</html>')
    expect(err.status).toBe(504)
    expect(err.code).toBeUndefined()
  })
})

describe('classifyGraphFailure', () => {
  it('a backend-confirmed outage is the ONLY 5xx that reads as unavailable', () => {
    expect(classifyGraphFailure(apiError(503, { detail: { code: 'PROVIDER_UNAVAILABLE' } }))).toBe('unavailable')
    expect(classifyGraphFailure(apiError(504, { detail: { code: 'PROVIDER_TIMEOUT' } }))).toBe('transient')
    expect(classifyGraphFailure(apiError(504, { detail: { code: 'REQUEST_TIMEOUT' } }))).toBe('transient')
    expect(classifyGraphFailure(apiError(504, '<html>upstream timed out</html>'))).toBe('transient')
    expect(classifyGraphFailure(apiError(502, ''))).toBe('transient')
    expect(classifyGraphFailure(apiError(500, { detail: { code: 'GRAPH_QUERY_ERROR' } }))).toBe('transient')
    expect(classifyGraphFailure(apiError(503, { detail: 'Service is starting up. Please retry shortly.' }))).toBe('transient')
  })

  it('load shedding is transient, a warming provider is warming', () => {
    expect(classifyGraphFailure(apiError(429, { detail: { code: 'PROVIDER_BUSY' } }))).toBe('transient')
    expect(classifyGraphFailure(apiError(503, { detail: { code: 'PROVIDER_LOADING' } }))).toBe('warming')
    expect(classifyGraphFailure(new Error('PROVIDER_LOADING'))).toBe('warming')
  })

  it('an expired session or a CSRF failure is never an outage', () => {
    expect(classifyGraphFailure(apiError(401, { detail: 'Not authenticated' }))).toBe('transient')
    expect(classifyGraphFailure(apiError(403, { detail: { error: 'csrf_failed' } }))).toBe('transient')
  })

  it('a client-side timeout is transient; no backend at all is unavailable', () => {
    expect(classifyGraphFailure(new TypeError('Request timed out after 30s (client-side limit)'))).toBe('transient')
    expect(classifyGraphFailure(new Error('Request timed out: POST /nodes/query'))).toBe('transient')
    expect(classifyGraphFailure(new TypeError('Failed to fetch'))).toBe('unavailable')
    expect(classifyGraphFailure(new Error('Provider unavailable (circuit open)'))).toBe('unavailable')
  })
})

describe('isProviderOutageSignal — what the client breaker counts', () => {
  it('counts only confirmed outages and network failures', () => {
    expect(isProviderOutageSignal(apiError(503, { detail: { code: 'PROVIDER_UNAVAILABLE' } }))).toBe(true)
    expect(isProviderOutageSignal(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('never counts slowness, shedding, gateway or session failures', () => {
    for (const err of [
      apiError(504, { detail: { code: 'PROVIDER_TIMEOUT' } }),
      apiError(502, ''),
      apiError(500, { detail: { code: 'GRAPH_QUERY_ERROR' } }),
      apiError(429, { detail: { code: 'PROVIDER_BUSY' } }),
      apiError(401, { detail: 'Not authenticated' }),
      new TypeError('Request timed out after 30s'),
    ]) {
      expect(isProviderOutageSignal(err)).toBe(false)
    }
  })
})

describe('isRetryableGraphFailure / retryDelayMs', () => {
  it('retries what the backend asked to retry, and slow requests', () => {
    expect(isRetryableGraphFailure(apiError(429, {}, { 'Retry-After': '1' }))).toBe(true)
    expect(isRetryableGraphFailure(apiError(503, { detail: { code: 'PROVIDER_LOADING' } }))).toBe(true)
    expect(isRetryableGraphFailure(apiError(504, {}))).toBe(true)
    expect(isRetryableGraphFailure(apiError(502, ''))).toBe(true)
    expect(isRetryableGraphFailure(new TypeError('Request timed out after 30s'))).toBe(true)
  })

  it('does not retry a confirmed outage, a rejected query or a session failure', () => {
    expect(isRetryableGraphFailure(apiError(503, { detail: { code: 'PROVIDER_UNAVAILABLE' } }))).toBe(false)
    expect(isRetryableGraphFailure(apiError(500, {}))).toBe(false)
    expect(isRetryableGraphFailure(apiError(401, {}))).toBe(false)
    expect(isRetryableGraphFailure(apiError(403, {}))).toBe(false)
  })

  it('honours Retry-After (capped) and backs off otherwise, always with jitter', () => {
    const hinted = retryDelayMs(apiError(429, {}, { 'Retry-After': '1' }), 0)
    expect(hinted).toBeGreaterThanOrEqual(1_000)
    expect(hinted).toBeLessThan(1_250)
    const capped = retryDelayMs(apiError(503, {}, { 'Retry-After': '30' }), 0)
    expect(capped).toBeLessThan(5_250)
    const first = retryDelayMs(apiError(504, {}), 0)
    const second = retryDelayMs(apiError(504, {}), 1)
    expect(first).toBeGreaterThanOrEqual(500)
    expect(second).toBeGreaterThanOrEqual(1_500)
  })
})

describe('isIdempotentGraphRead', () => {
  const ws = '/api/v1/ws_1/graph'
  it('every GET, and the POSTs that only query', () => {
    expect(isIdempotentGraphRead('GET', `${ws}/stats?dataSourceId=ds`)).toBe(true)
    for (const path of ['/nodes/query', '/edges/between', '/nodes/degree', '/search/advanced', '/trace/v2', '/trace/closure', '/edges/aggregated', '/assignments/compute']) {
      expect(isIdempotentGraphRead('POST', `${ws}${path}?dataSourceId=ds&viewId=v`)).toBe(true)
    }
  })

  it('never a write', () => {
    expect(isIdempotentGraphRead('POST', `${ws}/nodes/create`)).toBe(false)
    expect(isIdempotentGraphRead('POST', `${ws}/edges`)).toBe(false)
    expect(isIdempotentGraphRead('POST', `${ws}/save`)).toBe(false)
    expect(isIdempotentGraphRead('DELETE', `${ws}/nodes/x`)).toBe(false)
  })
})
