/**
 * Making a view from a large set: the server answers 202 with its progress
 * until the set is worked out, makes nothing meanwhile, and the same ask — the
 * same Idempotency-Key — is sent again until the view is made.
 */
import { describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn()
vi.mock('../apiClient', () => ({ authFetch: (...a: unknown[]) => authFetch(...a) }))
vi.mock('@/lib/queryClient', () => ({ queryClient: { invalidateQueries: vi.fn(), setQueryData: vi.fn() } }))

import { createFromMembers } from '../liveViewsApi'
import type { FromMembersRequest } from '@/types/membership'

const body = { name: 'Lineage', visibility: 'private', workspaceId: 'ws', mode: 'live', sources: [], layout: { kind: 'stages' }, keep: 'withResults', provenance: { origin: 'trace' } } as unknown as FromMembersRequest

describe('createFromMembers', () => {
  it('follows 202 progress with the same key until the view is made', async () => {
    const resolving = { status: 'resolving', sets: [] }
    authFetch.mockResolvedValueOnce(resolving).mockResolvedValueOnce(resolving)
      .mockResolvedValueOnce({ view: { id: 'v2' }, membership: {} })
    const progress = vi.fn()
    const out = await createFromMembers(body, 'key-1', progress)
    expect(out.view.id).toBe('v2')
    expect(progress).toHaveBeenCalledTimes(2)
    expect(authFetch).toHaveBeenCalledTimes(3)
    for (const [, init] of authFetch.mock.calls) {
      expect((init as { headers: Record<string, string> }).headers['Idempotency-Key']).toBe('key-1')
      expect(JSON.parse((init as { body: string }).body)).not.toHaveProperty('waitMs')
    }
  })

  it('asks again as it was through a slow, busy or dropped answer — never a second view', async () => {
    authFetch.mockReset()
    authFetch
      .mockRejectedValueOnce(Object.assign(new Error('Request timed out'), { status: 504, retryAfterMs: 5 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(Object.assign(new Error('short'), { status: 503, retryAfterMs: 5 }))
      .mockResolvedValueOnce({ view: { id: 'v3' }, membership: { status: 'updating' } })
    const onRetry = vi.fn()
    const out = await createFromMembers(body, 'key-2', undefined, { onRetry })
    expect(out.view.id).toBe('v3')
    expect(onRetry).toHaveBeenCalledTimes(3)
    for (const [, init] of authFetch.mock.calls) {
      expect((init as { headers: Record<string, string> }).headers['Idempotency-Key']).toBe('key-2')
    }
  }, 10000)

  it('a refusal is final, and Cancel stops asking', async () => {
    authFetch.mockReset()
    authFetch.mockRejectedValueOnce(Object.assign(new Error('over'), { status: 422 }))
    await expect(createFromMembers(body, 'key-3')).rejects.toThrow('over')
    expect(authFetch).toHaveBeenCalledTimes(1)
    authFetch.mockReset()
    authFetch.mockRejectedValue(Object.assign(new Error('busy'), { status: 429, retryAfterMs: 30_000 }))
    const controller = new AbortController()
    const asked = createFromMembers(body, 'key-4', undefined, { signal: controller.signal })
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    await expect(asked).rejects.toBeDefined()
    expect(authFetch).toHaveBeenCalledTimes(1)
  })
})
