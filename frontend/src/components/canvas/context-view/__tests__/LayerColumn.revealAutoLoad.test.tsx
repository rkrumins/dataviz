/**
 * The "N more" row versus a level the reveal just opened.
 *
 * That row is not the passive affordance it looks like: with `autoLoad` on it
 * is ALSO a one-page-ahead sentinel — dwell 300 ms inside the column's
 * viewport and it fetches the next page (`LoadMoreItem.tsx`). For ordinary
 * browsing that is the point; after a path-only reveal it is the whole bug.
 *
 * The reveal opens each level of the spine and scrolls the hit into view, so
 * every ancestor's "N more" row lands in the viewport WITHOUT the reader
 * having scrolled anywhere. Each one then pages itself. Live evidence
 * (view_9416e6306aa2, revealing `customer_id` three levels down): three
 * `children-with-edges` requests and three "Child entities loaded" notifications —
 * the exact cost E4 set out to remove, arriving through a door E4 never
 * looked at.
 *
 * The rule pinned here: a container whose loaded children ALL arrived
 * `viaReveal` has not been browsed by anyone. Nobody scrolled to its bottom,
 * so nothing may page it on their behalf. Its button still works, and the
 * moment one real page lands the row goes back to being a normal sentinel.
 */
import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
    ViewRowSearchContext,
    ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'


const layer: ViewLayerConfig = {
    id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff',
}

function node(
    id: string,
    data: Record<string, unknown> = {},
    children: HierarchyNode[] = [],
): HierarchyNode {
    return {
        id, urn: id, typeId: 'dataset', name: id, children,
        data: { label: id, urn: id, type: 'dataset', ...data },
        depth: 0, entityTypeOption: 'dataset', tags: [],
    }
}

/** Every IntersectionObserver the column mounts, with a way to fire it. */
let observers: Array<{ cb: IntersectionObserverCallback; el: Element | null }> = []

beforeEach(() => {
    // installJsdomLayout only stubs IntersectionObserver when there is none,
    // so ours has to go in AFTER it or it is the one that gets dropped.
    installJsdomLayout()
    observers = []
    vi.stubGlobal('IntersectionObserver', class {
        cb: IntersectionObserverCallback
        el: Element | null = null
        constructor(cb: IntersectionObserverCallback) {
            this.cb = cb
            observers.push(this)
        }
        observe(el: Element) { this.el = el }
        unobserve() {}
        disconnect() {
            const i = observers.findIndex((o) => o === (this as never))
            if (i >= 0) observers.splice(i, 1)
        }
        takeRecords() { return [] }
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

/** Scroll every mounted sentinel into view and hold it there past the dwell. */
function dwellInView() {
    act(() => {
        for (const o of observers) {
            o.cb(
                [{ isIntersecting: true, target: o.el } as unknown as IntersectionObserverEntry],
                null as unknown as IntersectionObserver,
            )
        }
    })
    act(() => { vi.advanceTimersByTime(400) })
}

function renderColumn(children: HierarchyNode[], session: ViewSearchSession) {
    const onLoadMore = vi.fn()
    // A container of ten, of which the column currently holds `children`.
    const parent = node('P', { type: 'container', childCount: 10 }, children)
    render(
        <ViewSearchSessionContext.Provider value={session}>
            <ViewRowSearchContext.Provider value={session.rowSearch}>
                <LayerColumn
                    layer={layer}
                    schema={null}
                    nodes={[parent]}
                    selectedNodeId={null}
                    expandedNodes={new Set(['P'])}
                    searchResults={new Set<string>()}
                    onSelect={vi.fn()}
                    onToggle={vi.fn()}
                    onContextMenu={vi.fn()}
                    onDoubleClick={vi.fn()}
                    onLoadMore={onLoadMore}
                    traceFocusId={null}
                    traceNodes={new Set<string>()}
                    traceContextSet={new Set<string>()}
                    isTracing={false}
                    overscan={200}
                />
            </ViewRowSearchContext.Provider>
        </ViewSearchSessionContext.Provider>,
    )
    return { onLoadMore }
}


describe('LayerColumn — the "N more" row after a reveal', () => {
    it('does not page a level whose only child the reveal put there', () => {
        vi.useFakeTimers()
        const { onLoadMore } = renderColumn(
            [node('spine-child', { viaReveal: true })],
            stubSession(),
        )

        dwellInView()

        expect(onLoadMore).not.toHaveBeenCalled()
    })

    // The sentinel is not the enemy — it is how a reader who scrolls to the
    // bottom of a long container keeps reading. Only the revealed case is
    // special, and only until one real page lands.
    it('still pages a container the reader has actually browsed', () => {
        vi.useFakeTimers()
        const { onLoadMore } = renderColumn(
            [node('page-1-child')],
            stubSession(),
        )

        dwellInView()

        expect(onLoadMore).toHaveBeenCalledWith('P', true)
    })

    it('resumes once a real page joins the revealed child', () => {
        vi.useFakeTimers()
        const { onLoadMore } = renderColumn(
            [node('spine-child', { viaReveal: true }), node('page-1-child')],
            stubSession(),
        )

        dwellInView()

        expect(onLoadMore).toHaveBeenCalledWith('P', true)
    })
})
