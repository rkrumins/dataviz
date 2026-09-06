/**
 * "Load all" — and, more to the point, when it STOPS.
 *
 * The loop is four lines, and every one of them is a stop condition. It
 * has to be a driven effect rather than an `await` loop: `loadMore`
 * closes over the page it is appending to, so it is a new function after
 * every page and a captured one would ask for page 2 forever. That shape
 * is also what makes the stops load-bearing — the effect re-fires on
 * every committed page, so anything it does not stop on, it repeats.
 *
 * These pin all five: no cursor, a cursor that did not move, a page
 * already in flight, the user's Stop, and the hard ceiling.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { PanelView, UseAdvancedSearchResult } from '@/hooks/useAdvancedSearch'
import { stubAdvanced } from '@/test/stubSearchSession'

import { useLoadAll } from '../useLoadAll'


/** A pipeline parked on a result page that offers `cursor` as its next. */
function page(cursor: string | null): PanelView {
    return {
        kind: 'results',
        template: { id: 't', name: 't' },
        inputs: {},
        query: {},
        result: {
            hits: [], truncated: false, candidateCount: 0,
            deadlineExceeded: false, elapsedMs: 1, cacheHit: false,
            cursor,
        },
        elapsedMs: 1,
    } as unknown as PanelView
}

/** Each call is a NEW pipeline object — that identity change is what
 *  re-fires the effect in the app, so the fixture has to reproduce it. */
function pipeline(over: Partial<UseAdvancedSearchResult> = {}) {
    return stubAdvanced({ view: page('c1'), ...over })
}

function render(initial = pipeline()) {
    return renderHook(
        ({ p }: { p: UseAdvancedSearchResult }) => ({ controls: useLoadAll(p), p }),
        { initialProps: { p: initial } },
    )
}


describe('useLoadAll', () => {
    it('asks for the next page as soon as it is started', () => {
        const p = pipeline()
        const { result } = render(p)
        expect(p.loadMore).not.toHaveBeenCalled()

        act(() => { result.current.controls.loadAll() })

        expect(p.loadMore).toHaveBeenCalledTimes(1)
        expect(result.current.controls.isLoadingAll).toBe(true)
    })

    it('walks page after page while the cursor keeps moving', () => {
        const first = pipeline()
        const { result, rerender } = render(first)
        act(() => { result.current.controls.loadAll() })

        const second = pipeline({ view: page('c2') })
        rerender({ p: second })
        expect(second.loadMore).toHaveBeenCalledTimes(1)

        const third = pipeline({ view: page('c3') })
        rerender({ p: third })
        expect(third.loadMore).toHaveBeenCalledTimes(1)
        expect(result.current.controls.isLoadingAll).toBe(true)
    })

    it('stops when the page comes back with no cursor', () => {
        const { result, rerender } = render()
        act(() => { result.current.controls.loadAll() })

        const last = pipeline({ view: page(null) })
        rerender({ p: last })

        expect(last.loadMore).not.toHaveBeenCalled()
        expect(result.current.controls.isLoadingAll).toBe(false)
    })

    it('stops when the cursor did NOT move — a page that never landed', () => {
        // Re-requesting the cursor we just handed over is the spin this
        // guard exists for: the effect fires on every render, and a failed
        // page leaves the result exactly as it was.
        const { result, rerender } = render()
        act(() => { result.current.controls.loadAll() })

        const retry = pipeline({ view: page('c1') })
        rerender({ p: retry })

        expect(retry.loadMore).not.toHaveBeenCalled()
        expect(result.current.controls.isLoadingAll).toBe(false)
    })

    it('stops when the query ends in an error', () => {
        const { result, rerender } = render()
        act(() => { result.current.controls.loadAll() })

        const failed = pipeline({ view: { kind: 'error', message: 'boom' } as PanelView })
        rerender({ p: failed })

        expect(failed.loadMore).not.toHaveBeenCalled()
        expect(result.current.controls.isLoadingAll).toBe(false)
    })

    it('never issues a page while one is in flight', () => {
        // `loadMore` parks its AbortController in the pipeline's single
        // `abortRef`; two overlapping calls would leave the first
        // unabortable.
        const busy = pipeline({ isLoadingMore: true })
        const { result, rerender } = render(busy)
        act(() => { result.current.controls.loadAll() })
        expect(busy.loadMore).not.toHaveBeenCalled()
        expect(result.current.controls.isLoadingAll).toBe(true)

        const idle = pipeline({ view: page('c2') })
        rerender({ p: idle })
        expect(idle.loadMore).toHaveBeenCalledTimes(1)
    })

    it("stops on the user's Stop, and leaves the pages already loaded", () => {
        const { result, rerender } = render()
        act(() => { result.current.controls.loadAll() })

        act(() => { result.current.controls.cancelLoadAll() })
        expect(result.current.controls.isLoadingAll).toBe(false)

        const next = pipeline({ view: page('c2') })
        rerender({ p: next })
        expect(next.loadMore).not.toHaveBeenCalled()
    })

    it('restarts cleanly after a Stop, from wherever the cursor now is', () => {
        const { result, rerender } = render()
        act(() => { result.current.controls.loadAll() })
        act(() => { result.current.controls.cancelLoadAll() })

        // Same cursor as the last request — a restart must not inherit the
        // previous run's "already asked for this one" memory.
        const resumed = pipeline({ view: page('c1') })
        rerender({ p: resumed })
        act(() => { result.current.controls.loadAll() })

        expect(resumed.loadMore).toHaveBeenCalledTimes(1)
    })

    it('gives up at the page ceiling rather than spinning the request lane', () => {
        const { result, rerender } = render(pipeline({ view: page('c0') }))
        act(() => { result.current.controls.loadAll() })

        // 199 more pages, each with a cursor that moves — the 200th request
        // is the last one the loop is willing to make.
        let last = pipeline()
        for (let i = 1; i < 200; i++) {
            last = pipeline({ view: page(`c${i}`) })
            rerender({ p: last })
        }
        expect(last.loadMore).toHaveBeenCalledTimes(1)
        expect(result.current.controls.isLoadingAll).toBe(true)

        const overTheLine = pipeline({ view: page('c200') })
        rerender({ p: overTheLine })

        expect(overTheLine.loadMore).not.toHaveBeenCalled()
        expect(result.current.controls.isLoadingAll).toBe(false)
    })
})
