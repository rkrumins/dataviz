/**
 * A `ViewSearchSession` that records what a surface asked it to do.
 *
 * Every consumer of the session reads it off a context, so testing one in
 * isolation means providing a whole session — and asserting on the CALL,
 * not on a re-render. Shared here because the header box, the layer
 * columns and the results panel all need the same fixture.
 *
 * Fields are plain `vi.fn()`s: nothing here simulates the pipeline. A
 * test that needs a particular pipeline state overrides `advanced`.
 */
import { createRef } from 'react'
import { vi } from 'vitest'

import { DEFAULT_QUICK } from '@/components/canvas/search/session/quickPredicate'
import type {
    ViewRowSearch,
    ViewSearchSession,
} from '@/components/canvas/search/session/useViewSearchSessionController'
import type { UseAdvancedSearchResult } from '@/hooks/useAdvancedSearch'


export function stubAdvanced(
    over: Partial<UseAdvancedSearchResult> = {},
): UseAdvancedSearchResult {
    return {
        view: { kind: 'idle' },
        runState: null,
        isIdle: true,
        selectTemplate: vi.fn(),
        setInput: vi.fn(),
        resetTemplate: vi.fn(),
        run: vi.fn(async () => {}),
        runTemplate: vi.fn(async () => {}),
        runPredicate: vi.fn(async () => {}),
        cancel: vi.fn(),
        loadMore: vi.fn(async () => {}),
        isLoadingMore: false,
        ...over,
    }
}


/**
 * The slice a layer column reads — deliberately its own fixture.
 *
 * A column subscribes to this and NOT to the session, so a test that
 * hands it a session field expects nothing to happen. Building it
 * separately is what makes that visible.
 */
export function stubRowSearch(over: Partial<ViewRowSearch> = {}): ViewRowSearch {
    return {
        scope: null,
        quick: null,
        resultMatchesQuick: false,
        view: null,
        setQuick: vi.fn(),
        clearScope: vi.fn(),
        openPanel: vi.fn(),
        ...over,
    }
}


export function stubSession(over: Partial<ViewSearchSession> = {}): ViewSearchSession {
    const session: ViewSearchSession = {
        viewId: 'view-1',
        quick: DEFAULT_QUICK,
        setQuick: vi.fn(),
        runNow: vi.fn(),
        clearQuery: vi.fn(),
        setScope: vi.fn(),
        clearScope: vi.fn(),
        panelOpen: false,
        openPanel: vi.fn(),
        closePanel: vi.fn(),
        togglePanel: vi.fn(),
        refineOpen: false,
        refine: vi.fn(),
        closeRefine: vi.fn(),
        // Default false: a surface that draws rows from the standing result
        // must opt IN to "this result answers the box", so a fixture that
        // forgets to say so fails loudly rather than drawing stale hits.
        resultMatchesQuick: false,
        inputRef: createRef<HTMLInputElement>(),
        resolveLayer: vi.fn(() => null),
        layers: [],
        advanced: stubAdvanced(),
        rowSearch: stubRowSearch(),
        ...over,
    }
    // Mirror the controller: the row slice carries the scoped query and
    // the pipeline only while a box has actually clamped the session, and
    // it drives the session through the session's own callbacks. A
    // fixture that let the two disagree would pass tests the app fails.
    if (!over.rowSearch) {
        const scope = session.quick.scope === 'view' ? null : session.quick.scope
        session.rowSearch = {
            scope,
            quick: scope ? session.quick : null,
            resultMatchesQuick: scope ? session.resultMatchesQuick : false,
            view: scope ? session.advanced.view : null,
            setQuick: session.setQuick,
            clearScope: session.clearScope,
            openPanel: session.openPanel,
        }
    }
    return session
}
