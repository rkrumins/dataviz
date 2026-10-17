/**
 * Cross-tab consolidation.
 *
 * The stream removes the per-tab *request* cost but not the per-tab
 * *connection* cost: five open tabs is five held connections doing
 * identical work, and at the documented scale that is thousands of them.
 * So one tab per browser does the work and broadcasts what it learns.
 *
 * What has to hold: exactly one tab connects, the others still see
 * changes, a tab opened mid-session is not blank until something
 * happens, and losing the leader promotes somebody rather than leaving
 * every tab silent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchChangeManifest = vi.hoisted(() => vi.fn())
vi.mock('@/services/changesService', () => ({ fetchChangeManifest }))

import {
  startChangeFeed,
  subscribeToTopic,
  currentVersions,
  __resetChangeFeedForTests,
} from '../changeFeed'

/** Minimal Web Locks: one holder at a time, FIFO queue, auto-release. */
class FakeLockManager {
  private held = new Set<string>()
  private queues = new Map<string, Array<() => void>>()

  request(name: string, cb: () => Promise<void>): Promise<void> {
    const run = () => {
      this.held.add(name)
      return cb().finally(() => {
        this.held.delete(name)
        const next = this.queues.get(name)?.shift()
        next?.()
      })
    }
    if (!this.held.has(name)) return run()
    return new Promise<void>((resolve) => {
      const queue = this.queues.get(name) ?? []
      queue.push(() => void run().then(resolve))
      this.queues.set(name, queue)
    })
  }
}

/** BroadcastChannel double that delivers to every OTHER instance. */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = []
  private listeners = new Set<(ev: MessageEvent) => void>()
  closed = false

  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this)
  }

  addEventListener(_type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.add(fn)
  }

  removeEventListener(_type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.delete(fn)
  }

  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.instances) {
      // A real BroadcastChannel never echoes to its own sender.
      if (other === this || other.closed) continue
      for (const fn of other.listeners) fn({ data } as MessageEvent)
    }
  }

  close() {
    this.closed = true
  }
}

class InertEventSource {
  static count = 0
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  constructor() {
    InertEventSource.count++
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

async function settle(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('change feed leader election', () => {
  let locks: FakeLockManager

  beforeEach(() => {
    __resetChangeFeedForTests()
    fetchChangeManifest.mockReset()
    fetchChangeManifest.mockResolvedValue({ announcements: 1 })
    FakeBroadcastChannel.instances = []
    InertEventSource.count = 0
    locks = new FakeLockManager()
    vi.stubGlobal('navigator', { locks })
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    vi.stubGlobal('EventSource', InertEventSource)
  })

  afterEach(() => {
    __resetChangeFeedForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('opens exactly one stream no matter how many tabs start', async () => {
    // This is the entire point: N tabs, one connection.
    const stops = [startChangeFeed(), startChangeFeed(), startChangeFeed()]
    await settle()

    expect(InertEventSource.count).toBe(1)
    stops.forEach((stop) => stop())
  })

  it('still seeds a tab that did not win the lock', async () => {
    // A tab opened mid-session holds nothing. Waiting for the leader's
    // next broadcast would leave it blank until something happened to
    // change — which for announcements could be weeks.
    const stop = startChangeFeed()
    await settle()

    expect(fetchChangeManifest).toHaveBeenCalled()
    expect(currentVersions()).toEqual({ announcements: 1 })
    stop()
  })

  it('releases leadership on teardown so another tab can take it', async () => {
    // Two real tabs are two module instances, which one test process
    // cannot have — the store's `transportEpoch` is module state, so a
    // second `startChangeFeed()` here would invalidate the first rather
    // than sit beside it. What IS testable, and is the whole failover
    // mechanism, is that leadership is genuinely relinquished: a waiter
    // queued on the same lock must get it when the leader tears down.
    const stopLeader = startChangeFeed()
    await settle()
    expect(InertEventSource.count).toBe(1)

    let promoted = false
    void locks.request('nx-change-feed-leader', async () => {
      promoted = true
    })
    await settle()
    expect(promoted).toBe(false) // the leader still holds it

    stopLeader()
    await settle()

    expect(promoted).toBe(true)
  })

  it('falls back to leading itself when Web Locks are unavailable', async () => {
    // jsdom and a few older browsers. Every tab leads: unconsolidated,
    // which is the pre-existing behaviour, but never silent.
    vi.stubGlobal('navigator', {})
    const stop = startChangeFeed()
    await settle()

    expect(InertEventSource.count).toBe(1)
    stop()
  })

  it('leads itself when the lock manager rejects', async () => {
    // Private-mode quirks and released contexts can reject. A tab with
    // no feed at all is the one outcome worth avoiding.
    vi.stubGlobal('navigator', {
      locks: { request: () => Promise.reject(new Error('no locks for you')) },
    })
    const stop = startChangeFeed()
    await settle()

    expect(InertEventSource.count).toBe(1)
    stop()
  })
})

describe('change feed follower', () => {
  beforeEach(() => {
    __resetChangeFeedForTests()
    fetchChangeManifest.mockReset()
    fetchChangeManifest.mockResolvedValue({})
    FakeBroadcastChannel.instances = []
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
    vi.stubGlobal('navigator', { locks: new FakeLockManager() })
    vi.stubGlobal('EventSource', InertEventSource)
  })

  afterEach(() => {
    __resetChangeFeedForTests()
    vi.unstubAllGlobals()
  })

  it('wakes its subscribers from a broadcast', async () => {
    // The follower runs no timer and holds no connection, so a broadcast
    // is the only thing that can wake it — if this does not work, every
    // non-leader tab is frozen.
    const refresh = vi.fn()
    subscribeToTopic('announcements', refresh, { minIntervalMs: 0 })

    const stop = startChangeFeed()
    await settle()

    // Stand in for the leader tab, which is a different BroadcastChannel
    // instance in another browsing context.
    const leaderChannel = new FakeBroadcastChannel('nx-change-feed')
    leaderChannel.postMessage({ versions: { announcements: 1 } })
    await settle()
    leaderChannel.postMessage({ versions: { announcements: 2 } })
    await settle()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(currentVersions()).toEqual({ announcements: 2 })
    stop()
  })

  it('ignores a malformed broadcast', async () => {
    const stop = startChangeFeed()
    await settle()

    const leaderChannel = new FakeBroadcastChannel('nx-change-feed')
    leaderChannel.postMessage({ versions: null })
    leaderChannel.postMessage('not an object at all')
    await settle()

    expect(currentVersions()).toEqual({})
    stop()
  })
})
