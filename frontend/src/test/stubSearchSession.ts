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
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
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


export function stubSession(over: Partial<ViewSearchSession> = {}): ViewSearchSession {
    return {
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
        inputRef: createRef<HTMLInputElement>(),
        resolveLayer: vi.fn(() => null),
        advanced: stubAdvanced(),
        ...over,
    }
}
