/**
 * "Edit in Code" on what the Form can't show opens Code mode on that very
 * condition, selected — never the Advanced drawer's Options, which can't
 * edit the query at all.
 */
import { EditorView } from '@codemirror/view'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PanelView } from '@/hooks/useAdvancedSearch'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import { stubAdvanced } from '@/test/stubSearchSession'
import type { Predicate } from '@/types/search'

import { SearchMapPanel } from '../SearchMapPanel'


// jsdom measures no layout; CodeMirror asks Ranges for their boxes.
beforeAll(() => {
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }
    Range.prototype.getClientRects = (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as never
    Range.prototype.getBoundingClientRect = (() => rect) as never
})

const tag = (value: string): Predicate => ({ kind: 'tag', op: 'hasAny', values: [value] })
const DEEPEST: Predicate = { kind: 'group', op: 'and', children: [tag('e'), tag('f')] }
const DEEP: Predicate = { kind: 'group', op: 'and', children: [tag('a'), {
    kind: 'group', op: 'or', children: [tag('b'), {
        kind: 'group', op: 'and', children: [tag('c'), {
            kind: 'group', op: 'or', children: [tag('d'), DEEPEST] }] }] }] }

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
    )
}

const editor = () => EditorView.findFromDOM(document.querySelector('.cm-content') as HTMLElement)!
const selected = () => {
    const { from, to } = editor().state.selection.main
    return editor().state.doc.toString().slice(from, to)
}


describe('SearchMapPanel — Edit in Code', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
        useSearchStore.getState().commitDraft(DEEP)
    })

    it('opens Code mode on a group nested deeper than the Form shows, selected', () => {
        renderPanel()
        fireEvent.click(screen.getByRole('button', { name: /Edit in Code/ }))

        expect(screen.getByRole('radio', { name: 'Code' })).toBeChecked()
        expect(selected()).toBe('(tag:e AND tag:f)')
    })

    it('selects nothing when Code is chosen again by hand later', () => {
        renderPanel()
        fireEvent.click(screen.getByRole('button', { name: /Edit in Code/ }))
        fireEvent.click(screen.getByRole('radio', { name: 'Form' }))
        fireEvent.click(screen.getByRole('radio', { name: 'Code' }))

        expect(selected()).toBe('')
    })
})
