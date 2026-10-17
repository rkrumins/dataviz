/**
 * A canvas save carries its Idempotency-Key, so a retry after a lost answer gets the first save's
 * result back instead of landing twice; and it waits longer than the server's 120 s tier, so the
 * answer to a slow save arrives instead of a client timeout that invites a retry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { applyGraphChanges } from '../versioningApiService'

beforeEach(() => {
  vi.mocked(fetchWithTimeout).mockReset()
  vi.mocked(fetchWithTimeout).mockResolvedValue(
    new Response(JSON.stringify({ commitId: 'c1', assigned: {} }), { status: 200 }))
})

describe('applyGraphChanges', () => {
  it('sends the Idempotency-Key and waits out the server', async () => {
    await applyGraphChanges('ws', 'ds', 'br', [{ op: 'delete', kind: 'node', id: 'urn:a' }], 'm', 'k1')
    const init = vi.mocked(fetchWithTimeout).mock.calls[0][1] as RequestInit & { timeoutMs?: number }
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('k1')
    expect(init.timeoutMs).toBeGreaterThanOrEqual(150_000)
  })

  it('sends no key header when it has none', async () => {
    await applyGraphChanges('ws', 'ds', 'br', [])
    const init = vi.mocked(fetchWithTimeout).mock.calls[0][1] as RequestInit
    expect(init.headers).toBeUndefined()
  })
})
