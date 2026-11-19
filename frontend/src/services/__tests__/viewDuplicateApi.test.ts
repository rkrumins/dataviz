/**
 * A copy of a view made from a query that reaches a lot is worked out a step at a time: the
 * server answers 202 and makes nothing until it is complete, so the same ask — the same
 * Idempotency-Key — goes again and carries that one copy on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn()
vi.mock('../apiClient', () => ({ authFetch: (...a: unknown[]) => authFetch(...a) }))
vi.mock('@/lib/queryClient', () => ({ queryClient: { invalidateQueries: vi.fn(), setQueryData: vi.fn() } }))

import { duplicateView } from '../viewDuplicateApi'

const keyOf = (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers['Idempotency-Key']

describe('duplicateView', () => {
  beforeEach(() => { authFetch.mockReset() })

  it('asks again with the same key while the copy is worked out, until it is made', async () => {
    const resolving = { status: 'resolving', sets: [] }
    authFetch.mockResolvedValueOnce(resolving).mockResolvedValueOnce(resolving)
      .mockResolvedValueOnce({ view: { id: 'copy' }, membership: { status: 'updating' } })
    const out = await duplicateView('v1', { name: 'Copy' })
    expect(out.view.id).toBe('copy')
    expect(authFetch).toHaveBeenCalledTimes(3)
    const keys = authFetch.mock.calls.map(keyOf)
    expect(keys[0]).toBeTruthy()
    expect(new Set(keys).size).toBe(1)
    expect(authFetch.mock.calls[0][0]).toBe('/api/v1/views/v1/duplicate')
  })

  it('once worked out under its key, a busy answer is asked again; before that, it is final', async () => {
    authFetch.mockResolvedValueOnce({ status: 'resolving', sets: [] })
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503, retryAfterMs: 5 }))
      .mockResolvedValueOnce({ view: { id: 'copy' } })
    expect((await duplicateView('v1', {})).view.id).toBe('copy')

    authFetch.mockReset()
    authFetch.mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 503, retryAfterMs: 5 }))
    await expect(duplicateView('v2', {})).rejects.toThrow('busy')
    expect(authFetch).toHaveBeenCalledTimes(1)
  })

  it('each copy is its own: a new key each time', async () => {
    authFetch.mockResolvedValue({ view: { id: 'copy' } })
    await duplicateView('v1', {})
    await duplicateView('v1', {})
    expect(keyOf(authFetch.mock.calls[0])).not.toBe(keyOf(authFetch.mock.calls[1]))
  })
})
