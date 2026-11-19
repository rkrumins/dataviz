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
})
