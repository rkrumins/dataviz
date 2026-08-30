/**
 * Regression guard for the Advanced Search load-more runaway.
 *
 * The row that pages in a container's children used to be an `AutoLoadSentinel`
 * driven by an IntersectionObserver. Its one-shot latch was reset on every
 * re-render (the `onLoadMore` prop was a fresh closure each time), and in the
 * search panel's Isolate/Hide modes the children it loaded were filtered right
 * back out of the tree — so the column never grew, the sentinel never left the
 * observer's root margin, and it re-fired until the parent's entire childCount
 * was drained. A 600-match search turned into hundreds of unattended
 * /children-with-edges + /edges/aggregated requests.
 *
 * These tests pin the two properties that make that impossible:
 *   1. the row mounts NO IntersectionObserver, and
 *   2. it never fetches on its own — only on a click.
 */
import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { CHILDREN_PAGE_SIZE } from '@/config/pagination'
import { LoadMoreItem } from '../LoadMoreItem'

/** Records every IntersectionObserver constructed during a test. */
let observerConstructions = 0

beforeEach(() => {
    observerConstructions = 0
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            constructor() {
                observerConstructions += 1
            }
            observe() {}
            unobserve() {}
            disconnect() {}
            takeRecords() { return [] }
        },
    )
})

afterEach(() => {
    vi.unstubAllGlobals()
})

function renderRow(props: Partial<React.ComponentProps<typeof LoadMoreItem>> = {}) {
    const onLoadMore = vi.fn()
    const utils = render(
        <LoadMoreItem
            depth={1}
            parentIsLast={[false]}
            count={512}
            onLoadMore={onLoadMore}
            {...props}
        />,
    )
    return { onLoadMore, ...utils }
}

describe('LoadMoreItem', () => {
    it('mounts no IntersectionObserver and does not fetch on its own', () => {
        const { onLoadMore } = renderRow()

        expect(observerConstructions).toBe(0)
        expect(onLoadMore).not.toHaveBeenCalled()
    })

    it('stays inert across re-renders — the old sentinel re-fired on every one', () => {
        const onLoadMore = vi.fn()
        const { rerender } = render(
            <LoadMoreItem depth={1} parentIsLast={[false]} count={512} onLoadMore={onLoadMore} />,
        )

        // Re-render with a fresh callback identity each time, which is exactly what
        // defeated the sentinel's `firedRef` latch.
        for (let i = 0; i < 5; i++) {
            rerender(
                <LoadMoreItem
                    depth={1}
                    parentIsLast={[false]}
                    count={512}
                    onLoadMore={() => onLoadMore()}
                />,
            )
        }

        expect(observerConstructions).toBe(0)
        expect(onLoadMore).not.toHaveBeenCalled()
    })

    it('fetches exactly one page per click', () => {
        const { onLoadMore } = renderRow()

        fireEvent.click(screen.getByRole('button'))
        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('names the real page size and the remaining count', () => {
        renderRow({ count: 512 })

        const button = screen.getByRole('button')
        expect(button).toHaveAccessibleName(
            `Load ${CHILDREN_PAGE_SIZE} more of 512 remaining`,
        )
        expect(button).toHaveTextContent(`Load ${CHILDREN_PAGE_SIZE} more`)
        expect(button).toHaveTextContent('512 remaining')
    })

    it('offers only what is left when fewer than a page remain', () => {
        renderRow({ count: 7 })

        expect(screen.getByRole('button')).toHaveTextContent('Load 7 more')
    })

    it('tells the caller which fetches were asked for and which drifted in', () => {
        // The click is something the user did, and the canvas names it —
        // "Snowflake · 5 more (10 of 41)". The one-page-ahead sentinel is not,
        // and a message for every column the user scrolls past is the noise
        // that made these notifications worthless.
        vi.useFakeTimers()
        try {
            let fire: ((entries: { isIntersecting: boolean }[]) => void) | null = null
            vi.stubGlobal('IntersectionObserver', class {
                constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { fire = cb }
                observe() {}
                unobserve() {}
                disconnect() {}
                takeRecords() { return [] }
            })
            const onLoadMore = vi.fn()
            render(
                <LoadMoreItem depth={1} parentIsLast={[false]} count={512} autoLoad onLoadMore={onLoadMore} />,
            )

            act(() => { fire!([{ isIntersecting: true }]) })
            act(() => { vi.advanceTimersByTime(300) })
            expect(onLoadMore).toHaveBeenCalledWith(true)

            onLoadMore.mockClear()
            fireEvent.click(screen.getByRole('button'))
            expect(onLoadMore).toHaveBeenCalledWith()
        } finally {
            vi.useRealTimers()
        }
    })

    it('is inert while its page is in flight', () => {
        const { onLoadMore } = renderRow({ isLoading: true })

        const button = screen.getByRole('button')
        expect(button).toBeDisabled()

        fireEvent.click(button)
        expect(onLoadMore).not.toHaveBeenCalled()
    })
})
