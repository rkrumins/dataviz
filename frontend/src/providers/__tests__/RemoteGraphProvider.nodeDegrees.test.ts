/**
 * POST /nodes/degree asks for roll-up presence only when told to, and a
 * request without the flag is exactly what it was before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { RemoteGraphProvider } from '../RemoteGraphProvider'

const mockFetch = vi.mocked(fetchWithTimeout)

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockResolvedValue({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ a: { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } }),
    text: async () => JSON.stringify({ a: { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } }),
  } as unknown as Response)
})

const body = (call: number) => JSON.parse(String(mockFetch.mock.calls[call][1]?.body))

describe('RemoteGraphProvider.getNodeDegrees', () => {
  it('sends includeRollups when asked, and hands back what the server says', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_nd', dataSourceId: 'ds_nd' })
    expect(await provider.getNodeDegrees(['a'], ['FLOWS_TO'], { includeRollups: true }))
      .toEqual({ a: { in: 0, out: 0, rollupIn: 0, rollupOut: 1 } })
    expect(body(0)).toEqual({ urns: ['a'], edgeTypes: ['FLOWS_TO'], includeRollups: true })
  })

  it('leaves the flag out otherwise', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_nd2', dataSourceId: 'ds_nd2' })
    await provider.getNodeDegrees(['a'], ['FLOWS_TO'])
    expect(body(0)).toEqual({ urns: ['a'], edgeTypes: ['FLOWS_TO'] })
  })
})
