/**
 * `searchAdvanced` will soon fire on every debounced keystroke of a
 * search-as-you-type box, which means superseded requests must be
 * abortable. Today it takes no `AbortSignal`, and the provider's
 * `_inflight` map would dedupe two identical request bodies onto one
 * shared promise — so aborting the superseded call would reject the
 * identical superseding call too. This pins:
 *   - the signal is forwarded into the `fetchWithTimeout` RequestInit
 *   - aborting that signal rejects the `searchAdvanced` call
 *   - two identical signalled bodies produce two real fetches (no dedupe)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { TIMEOUTS } from '@/config/timeouts'
import { RemoteGraphProvider } from '../RemoteGraphProvider'
import type { SearchQuery } from '@/types/search'

const mockFetch = vi.mocked(fetchWithTimeout)

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response
}

const query = { predicate: { type: 'text', target: 'any', value: 'foo' } } as unknown as SearchQuery

beforeEach(() => {
  mockFetch.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('RemoteGraphProvider.searchAdvanced signal + timeout', () => {
  it('forwards the AbortSignal and the raised timeout in the RequestInit', async () => {
    mockFetch.mockResolvedValue(okJson({ hits: [] }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    const controller = new AbortController()

    await provider.searchAdvanced(query, { signal: controller.signal })

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0]
    expect(init?.signal).toBe(controller.signal)
    expect(init?.timeoutMs).toBe(TIMEOUTS.SEARCH_ADVANCED_MS)
    expect(TIMEOUTS.SEARCH_ADVANCED_MS).toBe(45_000)
  })

  it('rejects when the caller aborts the signal', async () => {
    mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = (init as RequestInit)?.signal
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })
    const controller = new AbortController()

    const pending = provider.searchAdvanced(query, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toThrow('Aborted')
  })

  it('two identical signalled bodies produce two fetches, not one deduped promise', async () => {
    mockFetch.mockResolvedValue(okJson({ hits: [] }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })

    await Promise.all([
      provider.searchAdvanced(query, { signal: new AbortController().signal }),
      provider.searchAdvanced(query, { signal: new AbortController().signal }),
    ])

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('regression: two identical UNsignalled bodies still dedupe to one fetch', async () => {
    mockFetch.mockResolvedValue(okJson({ hits: [] }))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })

    await Promise.all([
      provider.searchAdvanced(query),
      provider.searchAdvanced(query),
    ])

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('a finishing signalled call does not evict a concurrent unsignalled dedupe entry for the same body', async () => {
    let resolveUnsignalled!: (v: Response) => void
    const unsignalledPromise = new Promise<Response>((resolve) => { resolveUnsignalled = resolve })
    mockFetch.mockImplementation((_url, init) => (
      (init as RequestInit)?.signal ? Promise.resolve(okJson({ hits: [] })) : unsignalledPromise
    ))
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_1', dataSourceId: 'ds_1' })

    // A: unsignalled, still pending — occupies the shared cacheKey slot.
    const pendingA = provider.searchAdvanced(query)
    // B: signalled, same body — resolves and returns before A does.
    await provider.searchAdvanced(query, { signal: new AbortController().signal })
    // C: unsignalled, same body, fired after B finished — must dedupe
    // onto A rather than starting a third fetch (i.e. B's cleanup must
    // not have deleted A's still-pending _inflight entry).
    const pendingC = provider.searchAdvanced(query)

    resolveUnsignalled(okJson({ hits: [] }))
    await Promise.all([pendingA, pendingC])

    // 1 fetch for B (signalled) + 1 shared fetch for A/C (unsignalled) = 2.
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
