/**
 * The Ask bar reads a question back before anything changes — in the
 * Sentence's words, with roughly how many it matches and the entities
 * its names point at — and applies it on Enter: once, replacing the query
 * or adding to it. Earlier questions come back with ↑; Esc clears.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchCountsRequest, SearchResolveRequest } from '@/types/search'

import { buildAskVocabulary } from '../askVocabulary'
import { AskBar } from '../AskBar'
import { ASK_HISTORY_KEY } from '../askHistory'


const vocabulary = buildAskVocabulary({
    entityTypes: [{ id: 'dataset', name: 'Dataset', pluralName: 'Datasets' },
        { id: 'dashboard', name: 'Dashboard', pluralName: 'Dashboards' }],
    tagValues: ['PII', 'Finance'], propertyKeys: ['owner'], valueSamples: [], layers: [],
})

function setup(draft: Predicate | null = null, variant: 'hero' | 'compact' = 'compact') {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    const searchCounts = vi.fn(async (body: SearchCountsRequest) => ({
        counts: Object.fromEntries(body.items.map((i) => [i.id, { count: 12, status: 'complete' }])),
    }))
    const resolveSearchRefs = vi.fn(async (body: SearchResolveRequest) => ({
        results: body.refs.map(() => ({ count: 2, matches: [
            { urn: 'urn:a', displayName: 'Finance', entityType: 'container', ancestorPath: [
                { urn: 'urn:t', displayName: 'Tableau', entityType: 'dataPlatform' }] },
            { urn: 'urn:b', displayName: 'Finance', entityType: 'container' },
        ] })),
    }))
    Object.assign(provider, { searchCounts, resolveSearchRefs })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
            {children}
        </ProviderOverride>
    )
    const onAsk = vi.fn()
    render(<AskBar viewId="view-a" vocabulary={vocabulary} draft={draft} onAsk={onAsk}
                   presentTypes={['dataset', 'dashboard']} variant={variant} />, { wrapper })
    const input = screen.getByRole('textbox', { name: 'Ask about this view' })
    const ask = (q: string) => fireEvent.change(input, { target: { value: q } })
    return { input, ask, onAsk, searchCounts, resolveSearchRefs }
}


describe('AskBar', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
    })

    it('reads the question back, with how many it matches', async () => {
        const { ask } = setup()
        ask('datasets that feed dashboards')
        expect(screen.getByText('Reads as')).toBeInTheDocument()
        expect(screen.getByText('Find')).toBeInTheDocument()
        expect(screen.getByText('feed')).toBeInTheDocument()
        expect(await screen.findByText('12')).toBeInTheDocument()
        expect(screen.getByText('12 matches', { selector: '[aria-live]' })).toBeInTheDocument()
    })

    it('applies the question once on Enter, remembers it and clears', () => {
        const { ask, input, onAsk } = setup()
        ask('datasets tagged PII')
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onAsk).toHaveBeenCalledTimes(1)
        expect(onAsk).toHaveBeenCalledWith({ kind: 'group', op: 'and', children: [
            { kind: 'entityType', op: 'in', values: ['dataset'] }, { kind: 'tag', op: 'hasAny', values: ['PII'] }] })
        expect(input).toHaveValue('')
        expect(JSON.parse(localStorage.getItem(ASK_HISTORY_KEY)!)).toEqual(['datasets tagged PII'])
    })

    it('adds to the query when the question starts with "and"', () => {
        const draft: Predicate = { kind: 'entityType', op: 'in', values: ['dataset'] }
        const { ask, input, onAsk } = setup(draft)
        ask('and tagged PII')
        expect(screen.getByText('The query becomes')).toBeInTheDocument()
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onAsk).toHaveBeenCalledWith({ kind: 'group', op: 'and', children: [
            draft, { kind: 'tag', op: 'hasAny', values: ['PII'] }] })
    })

    it('reads a word the other way when its other reading is picked', () => {
        const { ask, input, onAsk } = setup()
        ask('finance dashboards')
        fireEvent.click(screen.getByRole('button', { name: 'a name' }))
        expect(screen.getByRole('button', { name: 'a name' })).toHaveAttribute('aria-pressed', 'true')
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onAsk.mock.calls[0][0].children[1]).toMatchObject({ kind: 'text', value: 'finance' })
    })

    it('looks up the names it points at, and offers the one meant when several share it', async () => {
        const { ask, resolveSearchRefs } = setup()
        ask('dashboards in Finance')
        const pick = await screen.findByRole('button', { name: /names 2 entities/ })
        expect(resolveSearchRefs).toHaveBeenCalledWith({ scope: { viewId: 'view-a' }, refs: [{ path: ['**', 'Finance'] }] },
            expect.anything())
        fireEvent.click(pick)
        const list = await screen.findByRole('dialog', { name: 'Which “Finance”' })
        expect(within(list).getByText('in Tableau')).toBeInTheDocument()
    })

    it('offers questions to try in the view\'s own words, plainer for Business', () => {
        const { input } = setup(null, 'hero')
        expect(screen.getByRole('button', { name: 'datasets that feed dashboards' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'datasets tagged PII' }))
        expect(input).toHaveValue('datasets tagged PII')
        expect(screen.getByText('Reads as')).toBeInTheDocument()
    })

    it('brings back earlier questions, and Esc clears', () => {
        localStorage.setItem(ASK_HISTORY_KEY, JSON.stringify(['unused datasets', 'dead ends']))
        const { input } = setup()
        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(input).toHaveValue('unused datasets')
        fireEvent.keyDown(input, { key: 'ArrowUp' })
        expect(input).toHaveValue('dead ends')
        fireEvent.keyDown(input, { key: 'ArrowDown' })
        expect(input).toHaveValue('unused datasets')
        fireEvent.keyDown(input, { key: 'Escape' })
        expect(input).toHaveValue('')
    })
})
