/**
 * The query card's header is there in every editor and every state: an
 * empty Form used to trade it for a landing card, which left no way back to
 * Sentence or Code, and no Undo after a New query.
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


const PII: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }

function renderPanel() {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    render(
        <ProviderOverride value={{
            provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1,
        } as never}>
            <SearchMapPanel open onClose={vi.fn()} viewId="view-1"
                            session={stubAdvanced({ view: { kind: 'idle' } as PanelView })} />
        </ProviderOverride>,
        { wrapper: MemoryRouter },
    )
}

const editor = (name: string) => screen.getByRole('radio', { name })


describe('SearchMapPanel — the query header', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
    })

    it('opens on the Form, with every editor a click away while the query is empty', () => {
        renderPanel()

        expect(editor('Form')).toBeChecked()
        fireEvent.click(editor('Sentence'))
        expect(editor('Sentence')).toBeChecked()
        fireEvent.click(editor('Code'))
        expect(editor('Code')).toBeChecked()
        // Back to the empty Form: the editors are still there to leave it by.
        fireEvent.click(editor('Form'))
        expect(editor('Form')).toBeChecked()
        expect(editor('Sentence')).toBeInTheDocument()
        expect(editor('Cypher')).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'Connections' })).toBeInTheDocument()
    })

    it('takes a New query back with the Undo beside it', () => {
        useSearchStore.getState().commitDraft(PII)
        renderPanel()

        fireEvent.click(screen.getByRole('button', { name: 'New query' }))
        expect(useSearchStore.getState().draftPredicate).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
        expect(useSearchStore.getState().draftPredicate).toEqual(PII)
    })

    it('has nothing to run, save or tag while the query is empty', () => {
        renderPanel()

        expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Save query' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'New query' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    })

    it('turns running as you edit off and on, and remembers it', () => {
        renderPanel()
        const auto = screen.getByRole('switch', { name: 'Run as you edit' })
        expect(auto).toBeChecked()

        fireEvent.click(auto)
        expect(auto).not.toBeChecked()
        expect(localStorage.getItem('synodic.advancedSearch.runMode')).toBe('manual')
    })
})
