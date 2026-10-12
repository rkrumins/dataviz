/**
 * ONE SSE STREAM PER RUNNING ROW WAS NEVER SELF-LIMITING.
 *
 * The premise in the original note was "HTTP/1.1 caps at 6, sufficient in
 * practice". Behind an HTTP/2 ingress there is no such cap: a Job History page
 * with thirty running rows opens thirty readers, each pinning a server-side
 * stream. And `onError` only flipped `connected`, leaving the reconnect to
 * `EventSource` — which retries roughly every 3 seconds, unjittered, with no
 * ceiling and no end, per row, per tab. A control plane that is down therefore
 * gets every open tab knocking in lockstep for as long as the tabs are open.
 * Nor did the stream close when the job finished: after the terminal event the
 * durable values come from the polled row, so the socket had nothing left to
 * carry and stayed open anyway.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useJob } from '../useJob'

interface FakeSource {
  url: string
  closed: boolean
  listeners: Map<string, Array<(ev: unknown) => void>>
  emit: (type: string, data?: unknown) => void
}

let sources: FakeSource[] = []

class FakeEventSource {
  constructor(public url: string) {
    const self: FakeSource = {
      url,
      closed: false,
      listeners: new Map(),
      emit: (type, data) => {
        for (const fn of self.listeners.get(type) ?? []) {
          fn({ data: JSON.stringify(data ?? {}) })
        }
      },
    }
    Object.assign(this, {
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        self.listeners.set(type, [...(self.listeners.get(type) ?? []), fn])
      },
      close: () => { self.closed = true },
    })
    sources.push(self)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(this as any)._self = self
  }
}

const live = () => sources.filter((s) => !s.closed)

beforeEach(() => {
  sources = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.spyOn(Math, 'random').mockReturnValue(0)          // no jitter, readable instants
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const terminalEvent = (jobId: string) => ({
  v: 1, type: 'terminal', job_id: jobId, kind: 'agg', sequence: 1,
  scope: { workspace_id: 'ws-1' }, ts: 't', payload: { status: 'completed' },
})

describe('the live job stream', () => {
  it('closes the stream on the terminal event rather than leaving it open', () => {
    const { result, unmount } = renderHook(() => useJob('ds-1', 'job-1', true))
    expect(live()).toHaveLength(1)

    act(() => { sources[0].emit('terminal', terminalEvent('job-1')) })
    expect(result.current.terminal).toBe(true)
    expect(live()).toHaveLength(0)
    unmount()
  })

  it('takes the reconnect off the browser and widens it, with a ceiling', () => {
    const { unmount } = renderHook(() => useJob('ds-1', 'job-1', true))
    act(() => { sources[0].emit('error') })

    // Closed by us — the browser's own ~3s unjittered forever-retry is gone.
    expect(sources[0].closed).toBe(true)
    expect(sources).toHaveLength(1)

    act(() => { vi.advanceTimersByTime(3000) })
    expect(sources).toHaveLength(2)                    // first gap: 3s

    act(() => { sources[1].emit('error') })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(sources).toHaveLength(2)                    // …the next is 6s
    act(() => { vi.advanceTimersByTime(3000) })
    expect(sources).toHaveLength(3)

    // And it stops widening rather than doubling out to hours.
    for (let i = 0; i < 8; i++) {
      act(() => { sources[sources.length - 1].emit('error') })
      act(() => { vi.advanceTimersByTime(60_000) })
    }
    const before = sources.length
    act(() => { sources[sources.length - 1].emit('error') })
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(sources).toHaveLength(before + 1)
    unmount()
  })

  it('caps how many streams the whole tab holds at once', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      renderHook(() => useJob('ds-1', `job-${i}`, true)),
    )
    // The rest run on the job-history poll, which owns the durable values.
    expect(live().length).toBeLessThanOrEqual(4)

    // The cap holds steady as slots turn over: a finished row frees one and a
    // waiting row takes it, rather than everyone streaming at once.
    const held = live().length
    act(() => { sources[0].emit('terminal', terminalEvent('job-0')) })
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(live().length).toBe(held)

    rows.forEach((r) => r.unmount())
    expect(live()).toHaveLength(0)
  })

  it('opens nothing for a row that is not active', () => {
    renderHook(() => useJob('ds-1', 'job-1', false))
    expect(sources).toHaveLength(0)
  })
})
