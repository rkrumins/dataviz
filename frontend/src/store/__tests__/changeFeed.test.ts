/**
 * The change feed's correctness properties.
 *
 * This store is what lets nine surfaces stop polling, so the thing that
 * matters is not that it fires — it is that it never *fails* to fire.
 * Every test here corresponds to a way a surface could be left showing
 * stale data forever, with no error and nothing in a log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchChangeManifest = vi.hoisted(() => vi.fn())
vi.mock('@/services/changesService', () => ({ fetchChangeManifest }))

import {
  pollChangeFeed,
  subscribeToTopic,
  subscribeToUserTopic,
  currentVersions,
  __resetChangeFeedForTests,
} from '../changeFeed'

/** Let the store's fire-and-forget refresh tasks settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('changeFeed', () => {
  beforeEach(() => {
    __resetChangeFeedForTests()
    fetchChangeManifest.mockReset()
  })

  afterEach(() => {
    __resetChangeFeedForTests()
    vi.useRealTimers()
  })

  it('does not refresh a subscriber on the first manifest', async () => {
    // The surface already fetched on mount. Firing here would double
    // every surface's boot cost — which is the load this store exists to
    // remove, reintroduced at startup.
    const refresh = vi.fn()
    subscribeToTopic('announcements', refresh)

    fetchChangeManifest.mockResolvedValue({ announcements: 7 })
    await pollChangeFeed()
    await settle()

    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes when the version moves', async () => {
    const refresh = vi.fn()
    subscribeToTopic('announcements', refresh, { minIntervalMs: 0 })

    fetchChangeManifest.mockResolvedValue({ announcements: 7 })
    await pollChangeFeed()
    await settle()

    fetchChangeManifest.mockResolvedValue({ announcements: 8 })
    await pollChangeFeed()
    await settle()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when the version is unchanged', async () => {
    const refresh = vi.fn()
    subscribeToTopic('announcements', refresh, { minIntervalMs: 0 })

    fetchChangeManifest.mockResolvedValue({ announcements: 7 })
    await pollChangeFeed()
    await settle()
    await pollChangeFeed()
    await settle()

    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes when a counter goes BACKWARDS', async () => {
    // Counters carry a TTL so Redis can evict them, and a missing counter
    // reads as 0. A `>` comparison would latch a long-lived tab forever:
    // holding 4000, it would never see 0 as newer and never fetch again.
    const refresh = vi.fn()
    subscribeToTopic('announcements', refresh, { minIntervalMs: 0 })

    fetchChangeManifest.mockResolvedValue({ announcements: 4000 })
    await pollChangeFeed()
    await settle()

    fetchChangeManifest.mockResolvedValue({ announcements: 0 })
    await pollChangeFeed()
    await settle()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('re-fires when a change lands while a refresh is in flight', async () => {
    // THE ordering invariant. The version is captured before the refresh
    // starts, so a change committed during it is not swallowed. Record
    // the post-refresh version instead and the client believes it holds
    // data it never fetched — permanently, and silently.
    let release: () => void = () => {}
    const refresh = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve }),
    )
    subscribeToTopic('announcements', refresh, { minIntervalMs: 0 })

    fetchChangeManifest.mockResolvedValue({ announcements: 1 })
    await pollChangeFeed()
    await settle()

    // v2 lands: the refresh starts and parks.
    fetchChangeManifest.mockResolvedValue({ announcements: 2 })
    await pollChangeFeed()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(1)

    // v3 commits while that refresh is still running.
    fetchChangeManifest.mockResolvedValue({ announcements: 3 })
    await pollChangeFeed()
    await settle()

    release()
    await settle()

    // The in-flight refresh only satisfied v2, so v3 must still be owed.
    await pollChangeFeed()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('retries after a failed refresh instead of recording the version', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(undefined)
    subscribeToTopic('announcements', refresh, { minIntervalMs: 0 })

    fetchChangeManifest.mockResolvedValue({ announcements: 1 })
    await pollChangeFeed()
    await settle()

    fetchChangeManifest.mockResolvedValue({ announcements: 2 })
    await pollChangeFeed()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(1)

    // Same version, but the last attempt failed — so it is still owed.
    await pollChangeFeed()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('honours the refresh floor', async () => {
    // A flapping provider must not turn every client's idle subscription
    // into a refetch storm — that would be worse than the poll it replaced.
    const refresh = vi.fn()
    subscribeToTopic('providers:status', refresh, { minIntervalMs: 60_000 })

    fetchChangeManifest.mockResolvedValue({ 'providers:status': 1 })
    await pollChangeFeed()
    await settle()

    fetchChangeManifest.mockResolvedValue({ 'providers:status': 2 })
    await pollChangeFeed()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(1)

    fetchChangeManifest.mockResolvedValue({ 'providers:status': 3 })
    await pollChangeFeed()
    await settle()
    expect(refresh).toHaveBeenCalledTimes(1) // inside the floor
  })

  it('matches a per-user topic by prefix, not by a composed name', async () => {
    // The client never builds `notif:<id>` — it cannot know it is allowed
    // to. The manifest contains only what this session may hear, so a
    // prefix match is both sufficient and incapable of reaching anyone else.
    const refresh = vi.fn()
    subscribeToUserTopic('notifications', refresh, { minIntervalMs: 0 })

    fetchChangeManifest.mockResolvedValue({ 'notif:usr_abc': 1 })
    await pollChangeFeed()
    await settle()

    fetchChangeManifest.mockResolvedValue({ 'notif:usr_abc': 2 })
    await pollChangeFeed()
    await settle()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stops firing after unsubscribe', async () => {
    const refresh = vi.fn()
    const unsubscribe = subscribeToTopic('announcements', refresh, {
      minIntervalMs: 0,
    })

    fetchChangeManifest.mockResolvedValue({ announcements: 1 })
    await pollChangeFeed()
    await settle()

    unsubscribe()

    fetchChangeManifest.mockResolvedValue({ announcements: 2 })
    await pollChangeFeed()
    await settle()

    expect(refresh).not.toHaveBeenCalled()
  })

  it('keeps other subscribers when one throws', async () => {
    const boom = vi.fn(() => {
      throw new Error('subscriber blew up')
    })
    const ok = vi.fn()
    subscribeToTopic('announcements', boom, { minIntervalMs: 0 })
    subscribeToTopic('announcements', ok, { minIntervalMs: 0 })

    fetchChangeManifest.mockResolvedValue({ announcements: 1 })
    await pollChangeFeed()
    await settle()
    fetchChangeManifest.mockResolvedValue({ announcements: 2 })
    await pollChangeFeed()
    await settle()

    expect(boom).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('exposes the latest versions for diagnostics', async () => {
    fetchChangeManifest.mockResolvedValue({ announcements: 3, features: 4 })
    await pollChangeFeed()
    expect(currentVersions()).toEqual({ announcements: 3, features: 4 })
  })
})
