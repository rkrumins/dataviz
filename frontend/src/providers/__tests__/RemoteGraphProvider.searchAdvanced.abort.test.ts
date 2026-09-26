/**
 * Review finding (B1): an external abort must not be laundered into a
 * circuit-breaker failure on the shared 'default' endpoint class.
 *
 * `fetchWithTimeout`'s `runOnce` links the caller's AbortSignal to its own
 * internal AbortController (fetchWithTimeout.ts:~720-726), and its catch
 * rewrites ANY AbortError — caller-initiated or its own timeout firing —
 * into the same generic `TypeError('Request timed out …')`
 * (fetchWithTimeout.ts:~761-764). `_doFetch` used to see that TypeError and
 * call `circuitBreaker.recordFailure()` unconditionally regardless of
 * cause. `classifyEndpoint('/search/advanced')` falls through to 'default'
 * — the class shared with `/nodes/*`, `/nodes/top-level`, etc — so three
 * fast superseded search-as-you-type keystrokes (abort, abort, abort, no
 * intervening success) would trip the breaker for 15s and fail unrelated
 * canvas reads too.
 *
 * This suite stubs only global `fetch` so the REAL `fetchWithTimeout` and
 * `RemoteGraphProvider._doFetch` run end to end — a mocked
 * `fetchWithTimeout` (as the sibling `searchAdvanced.test.ts` suite uses
 * for its request-shape assertions) can't see this side effect, because it
 * never executes `_doFetch`'s real error-handling branch.
 *
 * Each test uses its own workspace/dataSource id: `getCircuitBreaker` is a
 * module-level singleton keyed by (workspaceId, dataSourceId, class), so
 * reusing ids would let one test's recorded state bleed into the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '../RemoteGraphProvider'
import { getCircuitBreaker } from '@/services/circuitBreaker'
import type { SearchQuery } from '@/types/search'

const query = { predicate: { type: 'text', target: 'any', value: 'foo' } } as unknown as SearchQuery

/** Mimics the browser fetch contract for an aborted request: rejects with
 *  an AbortError once its `signal` fires, otherwise hangs — enough to
 *  drive `runOnce`'s abort-linking without a real network response. */
function abortableFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(abortableFetch)
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe('RemoteGraphProvider.searchAdvanced abort — circuit breaker isolation', () => {
  it('three fast superseded (aborted) searches do not open the shared "default" breaker', async () => {
    const provider = new RemoteGraphProvider({ workspaceId: 'ws_abort_1', dataSourceId: 'ds_abort_1' })
    const breaker = getCircuitBreaker('ws_abort_1', 'ds_abort_1', 'default')

    for (let i = 0; i < 3; i++) {
      const controller = new AbortController()
      const pending = provider.searchAdvanced(query, { signal: controller.signal })
      // POST requests await `ensureCsrfToken()` inside `fetchWithTimeout`
      // before `runOnce` attaches its abort listener on our signal
      // (fetchWithTimeout.ts). Aborting synchronously here would race
      // that gap: the listener isn't attached yet, so the abort event
      // fires with nobody listening and the request hangs forever. Flush
      // pending microtasks/timers first so the listener is attached
      // before we abort.
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.abort()
      await expect(pending).rejects.toBeTruthy()
    }

    // A real failure opens the breaker on the 3rd consecutive one — if
    // aborts were still being recorded as failures this would now be
    // false, and the next (unrelated) request on this provider/class
    // would be rejected with "Provider unavailable (circuit open)".
    expect(breaker.canRequest()).toBe(true)
  })
})
