/**
 * RemoteGraphProvider.runNativeQuery — a person's own Cypher reaches the
 * server once. It is never retried, not even on a 429 that says when to try
 * again: every run that reaches the server is recorded, so a replay would be
 * a second run. And a refusal is the console's to say, in place, so a 403
 * doesn't also open the app-wide access-denied notice.
 *
 * Stubs only global `fetch`, so the real `fetchWithTimeout` and `_doFetch` run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '../RemoteGraphProvider'

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

const BODY = { query: 'MATCH (n) RETURN n', limit: 50, timeoutMs: 5000 }

describe('RemoteGraphProvider.runNativeQuery', () => {
  it('posts the query once, to the view it was started from', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_n1', dataSourceId: 'ds_n1', viewId: 'view_n1' })
    fetchSpy.mockResolvedValue(jsonResponse(200, { engine: 'falkordb', columns: [], rows: [], rowCount: 0 }))

    await provider.runNativeQuery(BODY)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const sent = new URL(String(url), 'http://localhost')
    expect(sent.pathname).toMatch(/\/ws_n1\/graph\/search\/native$/)
    expect(sent.searchParams.get('viewId')).toBe('view_n1')
    expect(sent.searchParams.get('dataSourceId')).toBe('ds_n1')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual(BODY)
  })

  it('is never retried, even when the server says when to try again', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_n2', dataSourceId: 'ds_n2' })
    fetchSpy.mockImplementation(async () =>
      jsonResponse(429, { detail: { code: 'busy', message: 'Too many queries are running.', requestId: 'r' } },
        { 'Retry-After': '0' }),
    )

    await expect(provider.runNativeQuery(BODY)).rejects.toMatchObject({ status: 429 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('leaves a refusal to the console: no app-wide access-denied notice', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_n3', dataSourceId: 'ds_n3' })
    const denied = vi.fn()
    window.addEventListener('auth:access-denied', denied)
    fetchSpy.mockImplementation(async () =>
      jsonResponse(403, { detail: {
        code: 'missing_permission', message: "You can't run your own queries on this data source.",
        permission: 'workspace:native-query:read', requestId: 'r',
      } }),
    )
    try {
      await expect(provider.runNativeQuery(BODY)).rejects.toMatchObject({ status: 403 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(denied).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('auth:access-denied', denied)
    }
  })
})
