/**
 * useLocateManyOnCanvas — T24 F5.
 *
 * Covers the two reported failure modes:
 *   • a target below the virtualizer's overscan window used to be
 *     invisible to a plain DOM query forever — this pins that the
 *     virtualizer-aware pulse (`scrollHitIntoView`) is what actually
 *     brings it into the DOM, not luck.
 *   • the all-fail and some-fail cases now surface a notification instead of
 *     resolving silently, with an honest revealed/requested count.
 *
 * `getElementById`/`scrollHitIntoView` are faked as a tiny "virtualized
 * DOM": a target only exists (to `getElementById`) once its own pulse
 * has fired — exactly the shape a real overscan window produces.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { useLocateManyOnCanvas } from '../useLocateManyOnCanvas'

function fakeElement(): HTMLElement {
  return { getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 20 }) } as unknown as HTMLElement
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
})

describe('useLocateManyOnCanvas — off-window targets (T24 F5)', () => {
  it('a target the virtualizer never rendered gets revealed via the pulse, not left invisible', async () => {
    // "off-window": absent from the fake DOM until ITS pulse fires.
    const materialized = new Set<string>()
    const revealAndFocus = vi.fn().mockResolvedValue(undefined)
    const scrollHitIntoView = vi.fn((id: string) => materialized.add(id))
    const getElementById = vi.fn((id: string) => (materialized.has(id) ? fakeElement() : null))
    const notify = vi.fn()

    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus,
      scrollHitIntoView,
      getElementById,
      getScrollContainer: () => null,
      notify,
      settleMs: 0,
    }))

    let outcome: { revealed: number; requested: number } | undefined
    await act(async () => {
      outcome = await result.current(['off-window-target'])
    })

    // The virtualizer-aware path was actually invoked for it...
    expect(scrollHitIntoView).toHaveBeenCalledWith('off-window-target')
    // ...and a plain DOM query alone (never called before the pulse)
    // would have found nothing — the pulse is what changed that.
    expect(outcome).toEqual({ revealed: 1, requested: 1 })
    expect(notify).not.toHaveBeenCalled()
  })

  it('ancestors are expanded for EVERY target, including ones that never end up located', async () => {
    const revealAndFocus = vi.fn().mockResolvedValue(undefined)
    const notify = vi.fn()
    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus,
      scrollHitIntoView: vi.fn(),
      getElementById: () => null,   // nothing ever materializes
      getScrollContainer: () => null,
      notify,
      settleMs: 0,
    }))

    await act(async () => { await result.current(['a', 'b', 'c']) })

    // skipFocus: true — N per-node scrolls must never fight each other;
    // this hook does its own scrolling, one target at a time.
    expect(revealAndFocus).toHaveBeenCalledTimes(3)
    for (const id of ['a', 'b', 'c']) {
      expect(revealAndFocus).toHaveBeenCalledWith(id, { skipFocus: true })
    }
  })
})

describe('useLocateManyOnCanvas — feedback instead of silence (T24 F5)', () => {
  it('zero locatable targets shows an error notification with the honest count', async () => {
    const notify = vi.fn()
    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus: vi.fn().mockResolvedValue(undefined),
      scrollHitIntoView: vi.fn(),
      getElementById: () => null,
      getScrollContainer: () => null,
      notify,
      settleMs: 0,
    }))

    let outcome: { revealed: number; requested: number } | undefined
    await act(async () => { outcome = await result.current(['x', 'y', 'z']) })

    expect(outcome).toEqual({ revealed: 0, requested: 3 })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('3'))
  })

  it('a partial reveal shows a warning notification naming both counts, not just failing silently', async () => {
    const materialized = new Set(['found-1', 'found-2'])   // 'missing' never lands
    const notify = vi.fn()
    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus: vi.fn().mockResolvedValue(undefined),
      scrollHitIntoView: vi.fn(),
      getElementById: (id) => (materialized.has(id) ? fakeElement() : null),
      getScrollContainer: () => null,
      notify,
      settleMs: 0,
    }))

    let outcome: { revealed: number; requested: number } | undefined
    await act(async () => { outcome = await result.current(['found-1', 'found-2', 'missing']) })

    expect(outcome).toEqual({ revealed: 2, requested: 3 })
    expect(notify).toHaveBeenCalledTimes(1)
    const [type, message] = notify.mock.calls[0]!
    expect(type).toBe('warning')
    expect(message).toContain('2')
    expect(message).toContain('3')
  })

  it('a full reveal shows no notification at all — feedback is for failure, not for success', async () => {
    const materialized = new Set(['a', 'b'])
    const notify = vi.fn()
    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus: vi.fn().mockResolvedValue(undefined),
      scrollHitIntoView: vi.fn(),
      getElementById: (id) => (materialized.has(id) ? fakeElement() : null),
      getScrollContainer: () => null,
      notify,
      settleMs: 0,
    }))

    await act(async () => { await result.current(['a', 'b']) })
    expect(notify).not.toHaveBeenCalled()
  })

  it('an empty request is a no-op — no reveal calls, no notification', async () => {
    const revealAndFocus = vi.fn()
    const notify = vi.fn()
    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus,
      scrollHitIntoView: vi.fn(),
      getElementById: () => null,
      getScrollContainer: () => null,
      notify,
      settleMs: 0,
    }))

    let outcome: { revealed: number; requested: number } | undefined
    await act(async () => { outcome = await result.current([]) })
    expect(outcome).toEqual({ revealed: 0, requested: 0 })
    expect(revealAndFocus).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('useLocateManyOnCanvas — best-effort union centring', () => {
  it('scrolls the container to centre whatever ended up simultaneously located', async () => {
    const materialized = new Set(['a', 'b'])
    const scrollTo = vi.fn()
    const container = {
      getBoundingClientRect: () => ({ left: 0, right: 200, top: 0, bottom: 100 }),
      scrollLeft: 0,
      scrollTo,
    } as unknown as HTMLElement

    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus: vi.fn().mockResolvedValue(undefined),
      scrollHitIntoView: vi.fn(),
      getElementById: (id) => (materialized.has(id) ? fakeElement() : null),
      getScrollContainer: () => container,
      notify: vi.fn(),
      settleMs: 0,
    }))

    await act(async () => { await result.current(['a', 'b']) })
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('never throws when the scroll container is unavailable', async () => {
    const { result } = renderHook(() => useLocateManyOnCanvas({
      revealAndFocus: vi.fn().mockResolvedValue(undefined),
      scrollHitIntoView: vi.fn(),
      getElementById: () => fakeElement(),
      getScrollContainer: () => null,
      notify: vi.fn(),
      settleMs: 0,
    }))
    await act(async () => { await expect(result.current(['a'])).resolves.toBeDefined() })
  })
})
