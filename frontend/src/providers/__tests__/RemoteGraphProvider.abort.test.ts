/**
 * A REQUEST THE CALLER CANCELLED SAYS NOTHING ABOUT THE PROVIDER.
 *
 * The lazy trace holds several closure pages in flight at once and aborts all
 * of them when the reader presses Escape or re-anchors. Every one of those
 * arrived here as a `TypeError("Request timed out…")` — because
 * `fetchWithTimeout` dressed the caller's own `AbortError` up as a timeout —
 * and `_doFetch` counted each as a circuit-breaker failure. The breaker for
 * the `trace` endpoint class opens at three inside fifteen seconds, so ONE
 * exit was enough: the reader's next trace failed with "Provider unavailable
 * (circuit open)" against a backend that had never been asked anything it
 * could not answer.
 *
 * These tests drive the real `fetchWithTimeout` (only `fetch` itself is
 * stubbed), because the bug lived in the seam between the two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '../RemoteGraphProvider'
import { getCircuitBreaker, classifyEndpoint, resetAllCircuitBreakers } from '@/services/circuitBreaker'

const WS = 'ws1'
const DS = 'ds1'

function makeProvider(): RemoteGraphProvider {
  return new RemoteGraphProvider({ workspaceId: WS, dataSourceId: DS } as never)
}

/** A `fetch` that never resolves on its own — it settles only when the
 *  caller's signal aborts, exactly as the browser's does. */
function hangingFetch(): typeof globalThis.fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })) as typeof globalThis.fetch
}

const realFetch = globalThis.fetch

beforeEach(() => {
  resetAllCircuitBreakers()
  document.cookie = 'nx_csrf=test'
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

describe('RemoteGraphProvider — a caller abort is not a provider failure', () => {
  it('four aborted closures leave the trace breaker closed', async () => {
    globalThis.fetch = hangingFetch()
    const provider = makeProvider()
    const controller = new AbortController()

    const flights = [1, 2, 3, 4].map(n => provider.traceClosure!(
      { urn: `u${n}`, direction: 'both', upstreamDepth: 1, downstreamDepth: 1 },
      { signal: controller.signal },
    ).catch((err: unknown) => err))

    controller.abort()
    const errors = await Promise.all(flights)

    // The cancellation reaches the caller AS a cancellation — not as a
    // timeout, which is a claim about the backend.
    for (const err of errors) {
      expect(err).toBeInstanceOf(DOMException)
      expect((err as DOMException).name).toBe('AbortError')
    }

    const breaker = getCircuitBreaker(WS, DS, classifyEndpoint('/trace/closure'))
    expect(breaker.canRequest(), 'breaker opened on cancelled requests').toBe(true)
  })

  it('and the next trace still goes out', async () => {
    globalThis.fetch = hangingFetch()
    const provider = makeProvider()
    const controller = new AbortController()
    const flights = [1, 2, 3, 4].map(n => provider.traceClosure!(
      { urn: `u${n}`, direction: 'both', upstreamDepth: 1, downstreamDepth: 1 },
      { signal: controller.signal },
    ).catch(() => undefined))
    controller.abort()
    await Promise.all(flights)

    let asked = 0
    globalThis.fetch = (async () => {
      asked += 1
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ nodes: [], edges: [], containmentEdges: [] }),
      } as unknown as Response
    }) as typeof globalThis.fetch

    await provider.traceClosure!({ urn: 'again', direction: 'both', upstreamDepth: 1, downstreamDepth: 1 })
    expect(asked, 'the request never left the client').toBe(1)
  })

  it('an aborted flight is not handed to the caller that follows it', async () => {
    // Re-tracing the SAME focus in the same tick as the exit that cancelled
    // it: the in-flight map is keyed by method+url+body, and its entry is
    // only cleared when the promise SETTLES — so without dropping it on the
    // abort, the new trace is handed the dying one.
    globalThis.fetch = hangingFetch()
    const provider = makeProvider()
    const controller = new AbortController()
    const request = { urn: 'same', direction: 'both' as const, upstreamDepth: 1, downstreamDepth: 1 }

    const first = provider.traceClosure!(request, { signal: controller.signal })
    void first.catch(() => undefined)
    controller.abort()

    globalThis.fetch = (async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ nodes: [], edges: [], containmentEdges: [] }),
    } as unknown as Response)) as typeof globalThis.fetch

    // SAME TICK as the abort — the window the in-flight map leaves open.
    const second = provider.traceClosure!(request)
    expect(second, 'the dying flight was handed to the next caller').not.toBe(first)
    await expect(second).resolves.toBeTruthy()
    // What the FIRST promise settles as is a race with the stub swap and is
    // not the property under test — the property is that the second caller
    // got a request of its own rather than the cancelled one.
  })
})
