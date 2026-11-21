/**
 * Ask AI in the Ask bar: offered only while the assistant is on and set up — most where the
 * rule-based reading leaves words unplaced — and on ⌘↵. The draft reads back in the same place,
 * marked AI-drafted, with how many it finds and what it assumed; a choice it needs is offered as
 * chips and asked again with it; applying it says the AI drafted it (source `ai`).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/lib/queryClient'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useSearchStore } from '@/store/searchStore'
import { useWorkspacesStore } from '@/store/workspaces'
import type { Predicate, SearchCountsRequest } from '@/types/search'

import { buildAskVocabulary } from '../askVocabulary'
import { AskBar } from '../AskBar'


const vocabulary = buildAskVocabulary({
    entityTypes: [{ id: 'dataset', name: 'Dataset', pluralName: 'Datasets' },
        { id: 'dashboard', name: 'Dashboard', pluralName: 'Dashboards' }],
    tagValues: ['PII'], propertyKeys: [], valueSamples: [], layers: [],
})

const DRAFTED: Predicate = { kind: 'group', op: 'and', children: [
    { kind: 'entityType', op: 'in', values: ['dataset'] }, { kind: 'tag', op: 'hasAny', values: ['PII'] }] }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let configured = true
let draftAnswer: (body: Record<string, unknown>) => unknown
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/v1/ai/status')) return json({ configured, personas: { data: true, help: true } })
    if (url.endsWith('/api/v1/ai/query/draft')) return json(draftAnswer(JSON.parse(String(init?.body))))
    return json({}, 404)
})
const draftCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/query/draft'))
    .map(([, init]) => JSON.parse(String(init!.body)))

const realFetch = globalThis.fetch
beforeEach(() => {
    localStorage.clear()
    queryClient.clear()
    fetchMock.mockClear()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    configured = true
    draftAnswer = () => ({
        mode: 'search', predicate: DRAFTED, cypher: null,
        explanation: 'Datasets tagged PII.', assumptions: ['“sensitive” read as the tag PII'],
        count: 31, countExact: true, clarification: null, guard: null,
    })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: true } })
    useWorkspacesStore.setState({ activeWorkspaceId: 'ws-1', activeDataSourceId: 'ds-1' } as never)
    useSearchStore.getState().clear()
})
afterEach(() => { globalThis.fetch = realFetch })

function setup() {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    Object.assign(provider, {
        searchCounts: vi.fn(async (body: SearchCountsRequest) => ({
            counts: Object.fromEntries(body.items.map((i) => [i.id, { count: 7, status: 'complete' }])),
        })),
        resolveSearchRefs: vi.fn(async () => ({ results: [] })),
    })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
            workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
            {children}
        </ProviderOverride>
    )
    const onAsk = vi.fn()
    render(<AskBar viewId="view-a" vocabulary={vocabulary} draft={null} onAsk={onAsk} presentTypes={['dataset']} />, { wrapper })
    const input = screen.getByRole('textbox', { name: 'Ask about this view' })
    const ask = (q: string) => fireEvent.change(input, { target: { value: q } })
    return { input, ask, onAsk }
}


describe('Ask AI in the Ask bar', () => {
    it('is not offered while the assistant is off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: false } })
        const { ask } = setup()
        ask('sensitive datasets')
        await screen.findByText('Reads as')
        expect(screen.queryByRole('button', { name: 'Ask AI' })).not.toBeInTheDocument()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('is not offered when no model is connected', async () => {
        configured = false
        const { ask } = setup()
        ask('sensitive datasets')
        await waitFor(() => expect(fetchMock).toHaveBeenCalled())
        expect(screen.queryByRole('button', { name: 'Ask AI' })).not.toBeInTheDocument()
    })

    it('is offered where the rules left words unplaced, and reads the draft back marked AI-drafted', async () => {
        const { ask, input, onAsk } = setup()
        ask('sensitive datasets')
        expect(await screen.findByText('Not all of it was placed.')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }))

        expect(await screen.findByText('AI-drafted')).toBeInTheDocument()
        expect(await screen.findByText('31')).toBeInTheDocument()
        expect(screen.getByText('Find')).toBeInTheDocument()
        expect(screen.getByText('Datasets tagged PII.')).toBeInTheDocument()
        expect(screen.getByText('Assumed “sensitive” read as the tag PII')).toBeInTheDocument()
        expect(draftCalls()).toEqual([{
            context: { workspaceId: 'ws-1', dataSourceId: 'ds-1', viewId: 'view-a' },
            question: 'sensitive datasets', mode: 'search',
        }])

        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onAsk).toHaveBeenCalledWith(DRAFTED, 'ai')
        expect(input).toHaveValue('')
    })

    it('asks on ⌘↵ (Ctrl+Enter here) even when the rules read it all', async () => {
        const { ask, input } = setup()
        ask('datasets tagged PII')
        await screen.findByText('Reads as')
        expect(screen.queryByText('Not all of it was placed.')).not.toBeInTheDocument()
        fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
        expect(await screen.findByText('AI-drafted')).toBeInTheDocument()
        expect(draftCalls()).toHaveLength(1)
    })

    it('offers the choice a draft needs as chips, and asks again with it', async () => {
        draftAnswer = (body) => (body.choices ? {
            mode: 'search', predicate: DRAFTED, cypher: null, explanation: 'Tagged PII.', assumptions: [],
            count: 31, countExact: true, clarification: null, guard: null,
        } : {
            mode: 'search', predicate: null, cypher: null, explanation: '', assumptions: [],
            clarification: { id: 'clr_1', question: 'Which means sensitive?', options: [
                { id: 'opt_1', label: 'Tag “pii”', count: 31 }, { id: 'opt_2', label: 'personal_data is true', count: 12 }] },
            guard: null,
        })
        const { ask, onAsk, input } = setup()
        ask('sensitive datasets')
        fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }))
        expect(await screen.findByText('Which means sensitive?')).toBeInTheDocument()
        // Nothing to apply until the choice is made.
        expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: /Tag “pii”/ }))
        expect(await screen.findByText('Tagged PII.')).toBeInTheDocument()
        expect(draftCalls()[1]).toMatchObject({ question: 'sensitive datasets', choices: { clr_1: 'opt_1' } })
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onAsk).toHaveBeenCalledWith(DRAFTED, 'ai')
    })

    it('goes back to the rule-based reading on request, and when the question changes', async () => {
        const { ask, input, onAsk } = setup()
        ask('sensitive datasets')
        fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }))
        fireEvent.click(await screen.findByRole('button', { name: 'Use the rule-based reading instead' }))
        expect(screen.queryByText('AI-drafted')).not.toBeInTheDocument()
        ask('datasets tagged PII')
        fireEvent.keyDown(input, { key: 'Enter' })
        expect(onAsk).toHaveBeenCalledWith(DRAFTED)
    })
})
