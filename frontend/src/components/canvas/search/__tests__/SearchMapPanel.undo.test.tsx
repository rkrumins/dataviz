/**
 * ⌘Z / Ctrl+Z in the panel steps back through the changes to the query,
 * ⇧ forward again — but never inside a text field, which keeps its own.
 * The panel's Clear is one of those steps: Undo brings the query back.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { stubAdvanced } from '@/test/stubSearchSession'
import type { Predicate } from '@/types/search'

import { SearchMapPanel } from '../SearchMapPanel'


const RESULTS = {
    kind: 'results',
    query: {},
    result: {
        candidateCount: 1, truncated: false, deadlineExceeded: false, cacheHit: false, elapsedMs: 4,
        hits: [{ node: { urn: 'a', displayName: 'orders', entityType: 'table', properties: {} }, ancestorPath: [] }],
    },
    elapsedMs: 4,
} as unknown as PanelView

const PII: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
const BOTH: Predicate = { kind: 'group', op: 'and', children: [PII, { kind: 'entityType', op: 'in', values: ['dataset'] }] }

function renderPanel(view: PanelView = { kind: 'idle' } as PanelView) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1,
        } as never}>
            <SearchMapPanel open onClose={vi.fn()} viewId="view-1" session={stubAdvanced({ view })} />
        </ProviderOverride>,
        { wrapper: MemoryRouter },
    )
}

const draft = () => useSearchStore.getState().draftPredicate
const press = (el: Element, init: KeyboardEventInit) => fireEvent.keyDown(el, { key: 'z', ...init })
const card = () => document.querySelector('[data-search-panel-content]')!


describe('SearchMapPanel — undo from the keyboard', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
        useSearchStore.getState().commitDraft(PII)
        useSearchStore.getState().commitDraft(BOTH)
    })

    it('steps back with ⌘Z or Ctrl+Z, and forward with ⇧', () => {
        renderPanel()
        press(card(), { metaKey: true })
        expect(draft()).toEqual(PII)
        press(card(), { metaKey: true, shiftKey: true })
        expect(draft()).toEqual(BOTH)
        press(card(), { ctrlKey: true })
        expect(draft()).toEqual(PII)
    })

    it('leaves a text field its own undo', () => {
        renderPanel()
        press(screen.getByRole('textbox', { name: 'Ask about this view' }), { ctrlKey: true })
        expect(draft()).toEqual(BOTH)
    })

    it('brings the query back after Clear', () => {
        renderPanel(RESULTS)
        fireEvent.click(screen.getByRole('button', { name: 'Clear results' }))
        expect(draft()).toBeNull()
        press(card(), { metaKey: true })
        expect(draft()).toEqual(BOTH)
    })
})
