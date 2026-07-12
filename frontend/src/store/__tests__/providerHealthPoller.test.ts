import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/fetchWithTimeout', () => ({
  fetchWithTimeout: vi.fn(),
}))

import { fetchWithTimeout } from '@/services/fetchWithTimeout'

const mockFetch = vi.mocked(fetchWithTimeout)

/** Hold a request "in flight" until we release it, so we can re-enter the
 *  poller in exactly the window that leaked. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>((r) => {
    release = r
  })
  return { wait, release }
}

/**
 * These pollers are MODULE SINGLETONS, so each test imports them fresh
 * (`vi.resetModules`) to get clean module-scope state.
 *
 * THE BUG THESE GUARD (observed in production as a request storm):
 * `startPolling()` guarded re-entry on `pollTimer` — but `pollTimer` is only
 * assigned AFTER `await refresh()` resolves. For the entire duration of the
 * in-flight HTTP request it was still null, so the guard was a no-op and any
 * re-entrant caller spawned a SECOND self-rescheduling chain. Each new chain
 * overwrote the single shared `pollTimer`, so `stopPolling()` could only ever
 * cancel the most recent one — every older chain became immortal.
 *
 * The app shell calls `enable*Polling()` from an effect that re-runs (and
 * re-runs on every remount), and a `visibilitychange` listener calls it on every
 * tab focus. Chains therefore accumulated for the lifetime of the tab. Measured
 * in production: a 60s poll arriving 5.9x/second (~350 live chains), with the
 * heap climbing alongside as every chain retained its closure.
 *
 * It bites hardest exactly when a provider is DOWN, because the re-entrancy
 * window IS the in-flight request latency — and these endpoints probe the dead
 * provider with a 30s timeout. A healthy provider answers in milliseconds and
 * the window is too small to ever notice.
 */
describe('provider pollers — chain-leak contract', () => {
  beforeEach(() => {
    vi.resetModules()
    mockFetch.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('providerHealth: re-entry during an in-flight poll spawns only ONE chain', async () => {
    const g = gate()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        await g.wait
        return { providers: {} }
      },
    } as unknown as Response)

    const { enableProviderHealthPolling } = await import('../providerHealth')

    // Fires a poll that now parks inside `await refresh()`.
    enableProviderHealthPolling()
    await Promise.resolve()
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // Re-enter in exactly the window where `pollTimer` is still null — which is
    // what the shell's effect and the visibilitychange listener really do.
    enableProviderHealthPolling()
    enableProviderHealthPolling()
    enableProviderHealthPolling()
    await Promise.resolve()

    // Every leaked chain would have fired its own immediate request here.
    expect(mockFetch).toHaveBeenCalledTimes(1)

    g.release()
    await Promise.resolve()
    await Promise.resolve()

    // ...and still exactly one once the in-flight poll completes: the survivors
    // must not each re-arm on top of one another.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('providerStatus: a poll stopped mid-flight does not resurrect itself', async () => {
    vi.useFakeTimers()
    try {
      const g = gate()
      // Import from the SAME post-resetModules registry the store will import
      // from, or the spy lands on a different module instance and never fires.
      const { providerService } = await import('@/services/providerService')
      const spy = vi
        .spyOn(providerService, 'listStatus')
        .mockImplementation(async () => {
          await g.wait
          return []
        })

      const { enableProviderStatusPolling, disableProviderStatusPolling } =
        await import('../providerStatus')

      enableProviderStatusPolling()
      await Promise.resolve()
      expect(spy).toHaveBeenCalledTimes(1)

      // Stop while the request is still in flight. There is no timer handle to
      // clear yet, so only the epoch can retire this chain — without it, the
      // parked poll wakes up and re-arms itself, resurrecting a dead chain.
      disableProviderStatusPolling()

      g.release()
      await Promise.resolve()
      await Promise.resolve()

      await vi.advanceTimersByTimeAsync(300_000)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
