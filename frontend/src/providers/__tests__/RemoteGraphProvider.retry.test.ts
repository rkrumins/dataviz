/**
 * RemoteGraphProvider — what a failed graph read does to the circuit breaker,
 * and which failures are retried in place.
 *
 * Regression under test: any 5xx (a 504 from a slow query, a 502 during a
 * deploy, a 500 from a rejected query) and any client-side timeout counted as
 * a breaker failure. Three of them opened the shared 'default' breaker and
 * every later read was rejected in the browser with "Provider unavailable
 * (circuit open)" — the canvas read that as the graph being down, and only a
 * page reload (fresh breaker registry) cleared it.
 *
 * This suite stubs only global `fetch` so the REAL `fetchWithTimeout` and
 * `_doFetch` run end to end. Each test uses its own workspace/dataSource id —
 * the breaker registry is a module-level singleton.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '../RemoteGraphProvider'
import { getCircuitBreaker } from '@/services/circuitBreaker'

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

describe('RemoteGraphProvider — breaker signals', () => {
  it('three 504s from slow queries do NOT open the breaker', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_r1', dataSourceId: 'ds_r1' })
    const breaker = getCircuitBreaker('ws_r1', 'ds_r1', 'default')
    fetchSpy.mockImplementation(async () =>
      jsonResponse(504, { detail: { code: 'PROVIDER_TIMEOUT', reason: 'nodes.query exceeded 20s' } }, { 'Retry-After': '0' }),
    )

    for (let i = 0; i < 3; i++) {
      await expect(provider.getNodes({ urns: [`urn:${i}`] })).rejects.toMatchObject({ status: 504 })
    }
    expect(breaker.canRequest()).toBe(true)
  })

  it('three 503 PROVIDER_UNAVAILABLE answers DO open the breaker (resilience kept)', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_r2', dataSourceId: 'ds_r2' })
    const breaker = getCircuitBreaker('ws_r2', 'ds_r2', 'default')
    fetchSpy.mockImplementation(async () =>
      jsonResponse(503, { detail: { code: 'PROVIDER_UNAVAILABLE', reason: 'Circuit open' } }, { 'Retry-After': '30' }),
    )

    for (let i = 0; i < 3; i++) {
      await expect(provider.getNodes({ urns: [`urn:${i}`] })).rejects.toMatchObject({ status: 503, code: 'PROVIDER_UNAVAILABLE' })
    }
    // Only three fetches: a confirmed outage is not retried in place.
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(breaker.canRequest()).toBe(false)
    await expect(provider.getNodes({ urns: ['urn:x'] })).rejects.toThrow(/circuit open/)
  })

  it('a 500 from a rejected query is neither counted nor retried', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_r3', dataSourceId: 'ds_r3' })
    const breaker = getCircuitBreaker('ws_r3', 'ds_r3', 'default')
    fetchSpy.mockImplementation(async () =>
      jsonResponse(500, { detail: { code: 'GRAPH_QUERY_ERROR', reason: 'Invalid input' } }),
    )
    for (let i = 0; i < 3; i++) {
      await expect(provider.getNodes({ urns: [`urn:${i}`] })).rejects.toMatchObject({ status: 500 })
    }
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(breaker.canRequest()).toBe(true)
  })
})

describe('RemoteGraphProvider — in-place retries for idempotent reads', () => {
  it('a 429 with Retry-After is retried and the retry succeeds', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_r4', dataSourceId: 'ds_r4' })
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(429, { detail: { code: 'PROVIDER_BUSY' } }, { 'Retry-After': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, [{ urn: 'urn:a', entityType: 'table', displayName: 'a' }]))

    const nodes = await provider.getNodes({ urns: ['urn:a'] })
    expect(nodes).toHaveLength(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('gives up after the retry budget and surfaces the last failure', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_r5', dataSourceId: 'ds_r5' })
    fetchSpy.mockImplementation(async () =>
      jsonResponse(504, { detail: { code: 'REQUEST_TIMEOUT' } }, { 'Retry-After': '0' }),
    )
    await expect(provider.getEdgesBetween(['urn:a', 'urn:b'])).rejects.toMatchObject({ status: 504 })
    expect(fetchSpy).toHaveBeenCalledTimes(3) // 1 + MAX_READ_RETRIES
  })

  it('never replays a write', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_r6', dataSourceId: 'ds_r6' })
    fetchSpy.mockImplementation(async () =>
      jsonResponse(429, { detail: { code: 'PROVIDER_BUSY' } }, { 'Retry-After': '0' }),
    )
    await expect(
      provider.createNode({ entityType: 'table', displayName: 'x' } as never),
    ).rejects.toMatchObject({ status: 429 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not retry a session failure the fetch layer already replayed', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_r7', dataSourceId: 'ds_r7' })
    fetchSpy.mockImplementation(async () => jsonResponse(401, { detail: 'Not authenticated' }))
    await expect(provider.getNodes({ urns: ['urn:a'] })).rejects.toMatchObject({ status: 401 })
    // One data request (+ whatever /auth/refresh calls fetchWithTimeout
    // made on its own): no second POST /nodes/query.
    const dataCalls = fetchSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes('/nodes/query'))
    expect(dataCalls).toHaveLength(1)
  })
})
