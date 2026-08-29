/**
 * The one search session a canvas owns.
 *
 * `useViewSearchSession` doesn't run anything itself — it composes
 * `useAdvancedSearch`, which already owns the request pipeline (abort on
 * restart, superseded-response drops, cursor paging). What this hook adds
 * is everything the header box needs on top, and these tests pin the four
 * behaviours that are easy to get wrong:
 *
 *   * the debounce dispatches ONCE, at 300 ms, with the shared
 *     `SEARCH_OPTIONS` — a run per keystroke is the whole reason the old
 *     box was client-only;
 *   * Enter runs immediately AND the debounce that lands behind it stays
 *     quiet, because the hash it would dispatch is the one already run.
 *     Without that guard every Enter costs two identical queries;
 *   * the panel auto-opens on the first result set for a query and NOT
 *     again — a user who closes it must be able to keep it closed while
 *     more pages of the same query arrive;
 *   * what it runs is what it commits, so Refine opens on the identical
 *     condition row instead of an empty builder.
 *
 * `useAdvancedSearch` is mocked: this file is about composition, and the
 * pipeline it composes has its own suite (`hooks/__tests__`).
 */
import { act, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PanelView, RunState } from '@/hooks/useAdvancedSearch'
import type { SearchTemplate } from '@/components/canvas/search/searchTemplates'
import type { Predicate, SearchHit } from '@/types/search'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'

const mocks = vi.hoisted(() => ({
    runPredicate: vi.fn(),
    resetTemplate: vi.fn(),
    cancel: vi.fn(),
    loadMore: vi.fn(),
    /** Last (viewId, options) the session composed the pipeline with. */
    composedWith: { viewId: '', clearOnUnmount: true as boolean | undefined },
    /** What the mocked pipeline currently reports back. */
    state: { view: { kind: 'idle' }, runState: null } as {
        view: PanelView
        runState: RunState | null
    },
}))

vi.mock('@/hooks/useAdvancedSearch', () => ({
    useAdvancedSearch: (viewId: string, options?: { clearOnUnmount?: boolean }) => {
        mocks.composedWith.viewId = viewId
        mocks.composedWith.clearOnUnmount = options?.clearOnUnmount
        return {
            view: mocks.state.view,
            runState: mocks.state.runState,
            isIdle: mocks.state.view.kind === 'idle',
            selectTemplate: vi.fn(),
            setInput: vi.fn(),
            resetTemplate: mocks.resetTemplate,
            run: vi.fn(),
            runTemplate: vi.fn(),
            runPredicate: mocks.runPredicate,
            cancel: mocks.cancel,
            loadMore: mocks.loadMore,
            isLoadingMore: false,
        }
    },
}))

import { SEARCH_OPTIONS } from '@/components/canvas/search/searchOptions'
import { useSearchStore } from '@/store/searchStore'

import {
    ViewSearchSessionContext,
    useViewSearchSession as useProvidedSession,
    useViewSearchSessionOptional,
} from '../ViewSearchSessionContext'
import { useViewSearchSession } from '../useViewSearchSession'


const VIEW_ID = 'view-1'

const LEAF: Predicate = { kind: 'text', target: 'any', value: 'cust', match: 'substring' }

const TEMPLATE: SearchTemplate = {
    id: '__builder__', label: 'Custom query', description: '',
    icon: 'Wand2', section: 'find', inputs: [],
    build: () => ({ predicate: LEAF }),
}

/** A result set from the pipeline — the shape `view.kind === 'results'` carries. */
function resultsView(elapsedMs = 12): PanelView {
    return {
        kind: 'results',
        template: TEMPLATE,
        inputs: {},
        query: { predicate: LEAF, scope: { viewId: VIEW_ID } },
        result: {
            hits: [], aggregates: [], truncated: false, candidateCount: 0,
            deadlineExceeded: false, elapsedMs, cacheHit: false,
        },
        elapsedMs,
    }
}

function renderSession(
    layers: ViewLayerConfig[] = [],
    assignments: Record<string, LayerAssignmentEntry> = {},
) {
    return renderHook(() => useViewSearchSession({ viewId: VIEW_ID, layers, assignments }))
}


beforeEach(() => {
    vi.useFakeTimers()
    mocks.runPredicate.mockReset()
    mocks.resetTemplate.mockReset()
    mocks.cancel.mockReset()
    mocks.state.view = { kind: 'idle' }
    mocks.state.runState = null
    useSearchStore.getState().clear()
})

afterEach(() => {
    vi.useRealTimers()
})


describe('useViewSearchSession — composition', () => {
    it('binds the pipeline to the view and keeps highlights when the panel unmounts', () => {
        renderSession()
        expect(mocks.composedWith.viewId).toBe(VIEW_ID)
        expect(mocks.composedWith.clearOnUnmount).toBe(false)
    })

    it('starts on the default quick query with the panel closed', () => {
        const { result } = renderSession()
        expect(result.current.quick).toEqual({
            text: '', lookIn: 'everything', match: 'substring', scope: 'view',
        })
        expect(result.current.panelOpen).toBe(false)
        expect(result.current.refineOpen).toBe(false)
    })
})


describe('useViewSearchSession — debounced dispatch', () => {
    it('runs once, at 300 ms, with the text leaf and the shared options', () => {
        const { result } = renderSession()

        act(() => { result.current.setQuick({ text: 'cust' }) })
        act(() => { vi.advanceTimersByTime(299) })
        expect(mocks.runPredicate).not.toHaveBeenCalled()

        act(() => { vi.advanceTimersByTime(1) })
        expect(mocks.runPredicate).toHaveBeenCalledTimes(1)
        expect(mocks.runPredicate).toHaveBeenCalledWith(LEAF, SEARCH_OPTIONS)
    })

    it('a keystroke inside the window restarts it — one run for the final word', () => {
        const { result } = renderSession()

        act(() => { result.current.setQuick({ text: 'cus' }) })
        act(() => { vi.advanceTimersByTime(200) })
        act(() => { result.current.setQuick({ text: 'cust' }) })
        act(() => { vi.advanceTimersByTime(299) })
        expect(mocks.runPredicate).not.toHaveBeenCalled()

        act(() => { vi.advanceTimersByTime(1) })
        expect(mocks.runPredicate).toHaveBeenCalledTimes(1)
        expect(mocks.runPredicate).toHaveBeenCalledWith(LEAF, SEARCH_OPTIONS)
    })

    it('commits the very predicate it runs, so Refine opens on the same condition row', () => {
        const { result } = renderSession()

        act(() => { result.current.setQuick({ text: 'cust' }) })
        act(() => { vi.advanceTimersByTime(300) })

        expect(useSearchStore.getState().draftPredicate).toEqual(LEAF)
    })

    it('waits for Enter under two characters', () => {
        const { result } = renderSession()

        act(() => { result.current.setQuick({ text: 'c' }) })
        act(() => { vi.advanceTimersByTime(300) })
        expect(mocks.runPredicate).not.toHaveBeenCalled()

        act(() => { result.current.runNow() })
        expect(mocks.runPredicate).toHaveBeenCalledTimes(1)
        expect(mocks.runPredicate).toHaveBeenCalledWith(
            { kind: 'text', target: 'any', value: 'c', match: 'substring' },
            SEARCH_OPTIONS,
        )
    })

    it('Enter on an empty box runs nothing', () => {
        const { result } = renderSession()
        act(() => { result.current.runNow() })
        expect(mocks.runPredicate).not.toHaveBeenCalled()
    })

    it('scopes the run to a container while a scope chip is on', () => {
        const { result } = renderSession()

        act(() => {
            result.current.setScope({ insideUrn: 'urn:db:orders', label: 'Orders' })
            result.current.setQuick({ text: 'cust' })
        })
        act(() => { vi.advanceTimersByTime(300) })

        expect(mocks.runPredicate).toHaveBeenCalledWith(
            {
                kind: 'group', op: 'and', children: [
                    LEAF,
                    { kind: 'descendantOf', urns: ['urn:db:orders'], uiScope: 'any' },
                ],
            },
            SEARCH_OPTIONS,
        )

        act(() => { result.current.clearScope() })
        expect(result.current.quick.scope).toBe('view')
    })
})


describe('useViewSearchSession — runNow', () => {
    it('runs immediately and the debounce behind it does not repeat the query', () => {
        const { result, rerender } = renderSession()

        act(() => { result.current.setQuick({ text: 'cust' }) })
        act(() => { result.current.runNow() })
        expect(mocks.runPredicate).toHaveBeenCalledTimes(1)

        // The pipeline reports the dispatched draft the way runPredicate does:
        // JSON.stringify of the predicate handed in.
        mocks.state.runState = { hash: JSON.stringify(LEAF), status: 'done' }
        rerender()

        act(() => { vi.advanceTimersByTime(300) })
        expect(mocks.runPredicate).toHaveBeenCalledTimes(1)
    })

    it('re-runs once the query changes again', () => {
        const { result, rerender } = renderSession()

        act(() => { result.current.setQuick({ text: 'cust' }) })
        act(() => { result.current.runNow() })
        mocks.state.runState = { hash: JSON.stringify(LEAF), status: 'done' }
        rerender()

        act(() => { result.current.setQuick({ match: 'prefix' }) })
        act(() => { vi.advanceTimersByTime(300) })

        expect(mocks.runPredicate).toHaveBeenCalledTimes(2)
        expect(mocks.runPredicate).toHaveBeenLastCalledWith(
            { kind: 'text', target: 'any', value: 'cust', match: 'prefix' },
            SEARCH_OPTIONS,
        )
    })
})


describe('useViewSearchSession — panel', () => {
    it('auto-opens on the first result set for a query, once', () => {
        const { result, rerender } = renderSession()
        expect(result.current.panelOpen).toBe(false)

        mocks.state.view = resultsView()
        mocks.state.runState = { hash: JSON.stringify(LEAF), status: 'done' }
        rerender()
        expect(result.current.panelOpen).toBe(true)

        act(() => { result.current.closePanel() })
        expect(result.current.panelOpen).toBe(false)

        // A second result set for the SAME query (a "load more" page)
        // must not reopen a panel the user closed.
        mocks.state.view = resultsView(31)
        rerender()
        expect(result.current.panelOpen).toBe(false)
    })

    it('opens again for a different query', () => {
        const { result, rerender } = renderSession()

        mocks.state.view = resultsView()
        mocks.state.runState = { hash: JSON.stringify(LEAF), status: 'done' }
        rerender()
        act(() => { result.current.closePanel() })

        mocks.state.runState = { hash: '{"kind":"text","value":"orders"}', status: 'done' }
        rerender()
        expect(result.current.panelOpen).toBe(true)
    })

    it('Refine opens the panel with the builder', () => {
        const { result } = renderSession()

        act(() => { result.current.refine() })
        expect(result.current.panelOpen).toBe(true)
        expect(result.current.refineOpen).toBe(true)

        act(() => { result.current.closePanel() })
        expect(result.current.refineOpen).toBe(false)
    })

    it('togglePanel flips it both ways', () => {
        const { result } = renderSession()
        act(() => { result.current.togglePanel() })
        expect(result.current.panelOpen).toBe(true)
        act(() => { result.current.togglePanel() })
        expect(result.current.panelOpen).toBe(false)
    })
})


describe('useViewSearchSession — clearQuery', () => {
    it('resets the quick query and tears the run down', () => {
        const { result } = renderSession()

        act(() => { result.current.setQuick({ text: 'cust' }) })
        act(() => { vi.advanceTimersByTime(300) })
        expect(useSearchStore.getState().draftPredicate).toEqual(LEAF)

        act(() => { result.current.clearQuery() })

        expect(result.current.quick.text).toBe('')
        expect(result.current.quick.scope).toBe('view')
        expect(mocks.resetTemplate).toHaveBeenCalledTimes(1)
        expect(useSearchStore.getState().draftPredicate).toBeNull()
    })

    it('a cleared query can be retyped and still auto-opens the panel', () => {
        const { result, rerender } = renderSession()

        mocks.state.view = resultsView()
        mocks.state.runState = { hash: JSON.stringify(LEAF), status: 'done' }
        rerender()
        act(() => { result.current.closePanel() })

        act(() => { result.current.clearQuery() })
        mocks.state.view = { kind: 'idle' }
        mocks.state.runState = null
        rerender()

        mocks.state.view = resultsView()
        mocks.state.runState = { hash: JSON.stringify(LEAF), status: 'done' }
        rerender()
        expect(result.current.panelOpen).toBe(true)
    })
})


describe('useViewSearchSession — resolveLayer', () => {
    it('resolves a hit against the layers and assignments it was handed', () => {
        const layers: ViewLayerConfig[] = [{ id: 'L1', name: 'L1', entityTypes: [], order: 0 }]
        const assignments: Record<string, LayerAssignmentEntry> = {
            'urn:db:orders': { layerId: 'L1', inheritsChildren: true },
        }
        const { result } = renderSession(layers, assignments)

        const hit = {
            node: { urn: 'urn:col:total', entityType: 'column', displayName: 'total', properties: {} },
            ancestorPath: [{ urn: 'urn:db:orders', entityType: 'database', displayName: 'Orders' }],
        } as SearchHit

        expect(result.current.resolveLayer(hit)).toBe('L1')
    })

    it('a hit with no ancestor path on an open view is resolved by its own type', () => {
        const layers: ViewLayerConfig[] = [
            { id: 'L1', name: 'L1', entityTypes: ['database'], order: 0 },
        ]
        const { result } = renderSession(layers, {})

        const hit = {
            node: { urn: 'urn:db:orders', entityType: 'database', displayName: 'Orders', properties: {} },
        } as SearchHit

        expect(result.current.resolveLayer(hit)).toBe('L1')
    })
})


describe('ViewSearchSessionContext', () => {
    it('the required reader throws when no canvas provided a session', () => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(() => renderHook(() => useProvidedSession())).toThrow(/ViewSearchSession/)
        errors.mockRestore()
    })

    it('the optional reader returns null instead — the other canvases own their own search', () => {
        const { result } = renderHook(() => useViewSearchSessionOptional())
        expect(result.current).toBeNull()
    })

    it('reads back the session the canvas provided', () => {
        const { result: session } = renderSession()
        const wrapper = ({ children }: { children: ReactNode }) => createElement(
            ViewSearchSessionContext.Provider,
            { value: session.current },
            children,
        )
        const { result } = renderHook(() => useProvidedSession(), { wrapper })
        expect(result.current).toBe(session.current)
    })
})


describe('useViewSearchSession — view lifetime', () => {
    it('clears the published result-set when the session goes away', () => {
        const { result, unmount } = renderSession()

        act(() => { result.current.setQuick({ text: 'cust' }) })
        act(() => { vi.advanceTimersByTime(300) })
        expect(useSearchStore.getState().draftPredicate).toEqual(LEAF)

        unmount()
        expect(useSearchStore.getState().draftPredicate).toBeNull()
    })
})
