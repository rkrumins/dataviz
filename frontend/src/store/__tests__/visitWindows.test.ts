/**
 * "Since your last visit" must count from when you last LOOKED (not when that
 * visit began, or it re-flags your own changes), must not move while you work,
 * and must survive a reload within the same visit.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SESSION_GAP_MS, useVisitWindowsStore } from '../visitWindows'

const KEY = 'u1:explorer'
const T0 = Date.UTC(2026, 9, 12, 9, 0)
const MIN = 60_000

const rec = () => useVisitWindowsStore.getState().visits[KEY]
const touch = (t: number) => useVisitWindowsStore.getState().touch(KEY, t)

beforeEach(() => useVisitWindowsStore.setState({ visits: {} }))

describe('visit windows', () => {
  it('has no window on a first visit', () => {
    touch(T0)
    expect(rec().windowFrom).toBeNull()
  })

  it('keeps one visit going through heartbeats and reloads', () => {
    touch(T0)
    touch(T0 + 10 * MIN)
    touch(T0 + 25 * MIN) // a reload within the gap is the same visit
    expect(rec().sessionStartedAt).toBe(T0)
    expect(rec().windowFrom).toBeNull()
  })

  it('opens a window from the end of the last visit to the start of this one', () => {
    touch(T0)
    touch(T0 + 20 * MIN) // last heartbeat of visit one
    const back = T0 + 20 * MIN + SESSION_GAP_MS + 1
    touch(back)
    expect(rec().windowFrom).toBe(T0 + 20 * MIN)
    expect(rec().sessionStartedAt).toBe(back)
    // Working on doesn't move it.
    touch(back + 5 * MIN)
    expect(rec().windowFrom).toBe(T0 + 20 * MIN)
    expect(rec().sessionStartedAt).toBe(back)
  })

  it('forgets the window once marked as seen', () => {
    touch(T0)
    touch(T0 + SESSION_GAP_MS + 1)
    useVisitWindowsStore.getState().markSeen(KEY)
    expect(rec().windowFrom).toBeNull()
  })

  it('drops surfaces not seen for half a year', () => {
    useVisitWindowsStore.getState().touch('u1:ws:old', T0)
    touch(T0 + 181 * 24 * 60 * MIN)
    expect(useVisitWindowsStore.getState().visits['u1:ws:old']).toBeUndefined()
  })
})
