/**
 * cacheEnvelope — what an enveloped fetch does to the SHARED circuit breaker.
 *
 * Regression under test: this path counted ANY 5xx toward the
 * `(workspace, dataSource, 'default')` breaker it shares with the canvas's own
 * reads. Under a slow backend, three 504s on `/stats` (or the wizard's entity
 * step, or an ontology helper) opened that breaker, and the view's next
 * `/nodes/query` fast-failed in the browser as "Provider unavailable (circuit
 * open)" — which the canvas rendered as "Graph service is unavailable" over a
 * graph that was merely slow. It must read failures exactly as `_doFetch`
 * does: only a confirmed outage, or a request that never reached the backend.
 *
 * Stubs only global `fetch`, so the real `fetchWithTimeout` runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchEnveloped } from '../cacheEnvelope'
import { getCircuitBreaker } from '../circuitBreaker'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  fetchSpy.mockRestore()
})

const scope = (n: string) => ({ circuitScope: { workspaceId: `ws_env_${n}`, dataSourceId: `ds_env_${n}` } })

describe('cacheEnvelope — breaker signals', () => {
  it('three 504s from slow queries do NOT open the shared breaker', async () => {
    const breaker = getCircuitBreaker('ws_env_a', 'ds_env_a', 'default')
    fetchSpy.mockImplementation(async () =>
      jsonResponse(504, { detail: { code: 'REQUEST_TIMEOUT', reason: 'Request timed out after 30s' } }, { 'Retry-After': '2' }),
    )

    for (let i = 0; i < 3; i++) {
      expect(await fetchEnveloped('/api/v1/ws_env_a/graph/stats', scope('a'))).toBeNull()
    }
    expect(breaker.canRequest()).toBe(true)
  })

  it('502s and 500s do not open it either', async () => {
    const breaker = getCircuitBreaker('ws_env_b', 'ds_env_b', 'default')
    for (const status of [502, 500, 502]) {
      fetchSpy.mockImplementationOnce(async () => new Response('<html>Bad Gateway</html>', { status }))
      expect(await fetchEnveloped('/api/v1/ws_env_b/graph/stats', scope('b'))).toBeNull()
    }
    expect(breaker.canRequest()).toBe(true)
  })

  it('a client-side timeout is slowness, not an outage', async () => {
    const breaker = getCircuitBreaker('ws_env_c', 'ds_env_c', 'default')
    fetchSpy.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    )

    for (let i = 0; i < 3; i++) {
      expect(await fetchEnveloped('/api/v1/ws_env_c/graph/stats', { ...scope('c'), timeoutMs: 1_000 })).toBeNull()
    }
    expect(breaker.canRequest()).toBe(true)
  })

  it('three confirmed outages DO open it, honoring Retry-After (resilience kept)', async () => {
    const breaker = getCircuitBreaker('ws_env_d', 'ds_env_d', 'default')
    fetchSpy.mockImplementation(async () =>
      jsonResponse(503, { detail: { code: 'PROVIDER_UNAVAILABLE', reason: 'Circuit open' } }, { 'Retry-After': '30' }),
    )

    for (let i = 0; i < 3; i++) {
      expect(await fetchEnveloped('/api/v1/ws_env_d/graph/stats', scope('d'))).toBeNull()
    }
    expect(breaker.canRequest()).toBe(false)
  })

  it('three dropped connections DO open it', async () => {
    const breaker = getCircuitBreaker('ws_env_e', 'ds_env_e', 'default')
    fetchSpy.mockImplementation(async () => { throw new TypeError('Failed to fetch') })

    for (let i = 0; i < 3; i++) {
      expect(await fetchEnveloped('/api/v1/ws_env_e/graph/stats', scope('e'))).toBeNull()
    }
    expect(breaker.canRequest()).toBe(false)
  })
})

describe('cacheEnvelope — an unscoped call is keyed by endpoint', () => {
  it('a failing bulk endpoint does not fast-fail a different unscoped endpoint', async () => {
    // The bulk endpoints span every workspace and data source, so ONE
    // unhealthy provider can fail them for everybody. When every unscoped
    // call shared one breaker, three such failures also fast-failed unrelated
    // endpoints for 15s — returning null, which callers cannot tell apart
    // from "no data" and render as zeros.
    const bulk = '/api/v1/admin/workspaces/datasources/cached-stats'
    const other = '/api/v1/admin/ontologies'

    fetchSpy.mockImplementation(async () => new Response('nope', { status: 503 }))
    for (let i = 0; i < 3; i++) expect(await fetchEnveloped(bulk)).toBeNull()

    fetchSpy.mockImplementation(async () => jsonResponse(200, { ok: true }))
    expect(await fetchEnveloped(other)).toEqual({ ok: true })
  })

  it('paging the same endpoint shares one breaker rather than minting one per page', async () => {
    fetchSpy.mockImplementation(async () => jsonResponse(200, { page: 1 }))
    expect(await fetchEnveloped('/api/v1/admin/things?offset=0')).toEqual({ page: 1 })
    expect(await fetchEnveloped('/api/v1/admin/things?offset=20')).toEqual({ page: 1 })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
