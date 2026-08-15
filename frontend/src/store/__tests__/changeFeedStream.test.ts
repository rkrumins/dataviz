/**
 * The streaming transport.
 *
 * The stream is what makes an idle tab cost nothing, but it is allowed
 * to lose things — so what has to be true is that every way it can fail
 * ends in a reconciliation rather than a surface stuck on stale data,
 * and that failing does not itself become expensive.
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

/** A drivable EventSource double. */
class FakeEventSource {
  static instances: FakeEventSource[] = []

  url: string
  withCredentials: boolean
  closed = false
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  private listeners = new Map<string, Set<(ev: MessageEvent) => void>>()

  constructor(url: string | URL, init?: { withCredentials?: boolean }) {
    this.url = String(url)
    this.withCredentials = Boolean(init?.withCredentials)
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }

  removeEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.get(type)?.delete(fn)
  }

  close() {
    this.closed = true
  }

  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent)
    }
  }

  fail() {
    this.onerror?.(new Event('error'))
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('change feed streaming transport', () => {
  let teardown: (() => void) | null = null

  beforeEach(() => {
    __resetChangeFeedForTests()
    fetchChangeManifest.mockReset()
    fetchChangeManifest.mockResolvedValue({})
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterEach(() => {
    teardown?.()
    teardown = null
    __resetChangeFeedForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('opens one credentialed stream', () => {
    teardown = startChangeFeed()

    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/v1/changes/stream')
    // HttpOnly cookie auth — the stream authenticates the same way every
    // other request does, which is why SSE fits here at all.
    expect(FakeEventSource.instances[0].withCredentials).toBe(true)
  })

  it('applies a pushed delta without a follow-up manifest read', async () => {
    teardown = startChangeFeed()
    const es = FakeEventSource.instances[0]
    fetchChangeManifest.mockClear()

    es.emit('changed', { topics: { announcements: 12 } })
    await settle()

    expect(currentVersions()).toEqual({ announcements: 12 })
    // The frame carries the version, so there is nothing left to ask.
    expect(fetchChangeManifest).not.toHaveBeenCalled()
  })

  it('wakes a subscriber from a pushed delta', async () => {
    const refresh = vi.fn()
    subscribeToTopic('announcements', refresh, { minIntervalMs: 0 })
    teardown = startChangeFeed()
    const es = FakeEventSource.instances[0]

    es.emit('changed', { topics: { announcements: 1 } })
    await settle()
    es.emit('changed', { topics: { announcements: 2 } })
    await settle()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reconciles on open, so a gap while disconnected is closed', async () => {
    teardown = startChangeFeed()
    fetchChangeManifest.mockClear()

    FakeEventSource.instances[0].onopen?.(new Event('open'))
    await settle()

    expect(fetchChangeManifest).toHaveBeenCalled()
  })

  it('reconciles on a resync frame', async () => {
    teardown = startChangeFeed()
    fetchChangeManifest.mockClear()

    FakeEventSource.instances[0].emit('resync', {})
    await settle()

    expect(fetchChangeManifest).toHaveBeenCalled()
  })

  it('reconciles rather than failing on an unparseable frame', async () => {
    teardown = startChangeFeed()
    const es = FakeEventSource.instances[0]
    fetchChangeManifest.mockClear()

    for (const fn of (es as any).listeners.get('changed') ?? []) {
      fn({ data: 'not json at all' } as MessageEvent)
    }
    await settle()

    expect(fetchChangeManifest).toHaveBeenCalled()
  })

  it('CLOSES the failed stream before scheduling a retry', async () => {
    // Non-negotiable. EventSource reconnects on its own, so a handler
    // that only records state leaves the browser's retry running
    // alongside ours — the connection count then doubles on every
    // failure, which is worst exactly when the backend is already
    // struggling. `useJob.ts`'s onError does not close; do not copy it.
    vi.useFakeTimers()
    teardown = startChangeFeed()
    const first = FakeEventSource.instances[0]

    first.fail()

    expect(first.closed).toBe(true)
  })

  it('reconnects after a failure, with a bounded delay', async () => {
    vi.useFakeTimers()
    teardown = startChangeFeed()
    expect(FakeEventSource.instances).toHaveLength(1)

    FakeEventSource.instances[0].fail()
    // Full jitter means the delay is somewhere in (0, ceiling]; advancing
    // past the ceiling guarantees it has fired.
    await vi.advanceTimersByTimeAsync(31_000)

    expect(FakeEventSource.instances.length).toBeGreaterThan(1)
  })

  it('reopens on a reauth frame', async () => {
    // The server ends streams on a schedule so authorization stays fresh;
    // that is a planned handover, not an error.
    vi.useFakeTimers()
    teardown = startChangeFeed()
    const first = FakeEventSource.instances[0]

    first.emit('reauth', { reason: 'max-lifetime' })
    await vi.advanceTimersByTimeAsync(31_000)

    expect(first.closed).toBe(true)
    expect(FakeEventSource.instances.length).toBeGreaterThan(1)
  })

  it('keeps the manifest poll as a floor beneath the stream', async () => {
    // The poll is what makes the stream safe to be lossy. If a bump is
    // lost to a Redis blip, or a stream is refused because a process is
    // full, this is what still notices.
    vi.useFakeTimers()
    teardown = startChangeFeed()
    fetchChangeManifest.mockClear()

    await vi.advanceTimersByTimeAsync(90_000)

    expect(fetchChangeManifest).toHaveBeenCalled()
  })

  it('keeps polling even while this tab is hidden', async () => {
    // The tab holding the lock works for every tab in the browser, and it
    // is very often a background one while the user reads a different
    // tab. Pausing here — which is what every poller this replaced did —
    // would stop the reconciliation floor for tabs somebody is looking at.
    vi.useFakeTimers()
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    try {
      teardown = startChangeFeed()
      fetchChangeManifest.mockClear()

      await vi.advanceTimersByTimeAsync(90_000)

      expect(fetchChangeManifest).toHaveBeenCalled()
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    }
  })

  it('stops the stream on teardown', () => {
    const stop = startChangeFeed()
    const es = FakeEventSource.instances[0]

    stop()

    expect(es.closed).toBe(true)
  })

  it('does not reconnect after teardown', async () => {
    vi.useFakeTimers()
    const stop = startChangeFeed()
    const es = FakeEventSource.instances[0]

    stop()
    es.fail()
    await vi.advanceTimersByTimeAsync(31_000)

    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('runs poll-only when asked, for environments with no EventSource', async () => {
    vi.useFakeTimers()
    teardown = startChangeFeed({ stream: false })

    expect(FakeEventSource.instances).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(fetchChangeManifest).toHaveBeenCalled()
  })
})
