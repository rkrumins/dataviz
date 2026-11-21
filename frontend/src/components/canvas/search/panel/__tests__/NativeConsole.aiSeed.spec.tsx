/**
 * Cypher drafted by the AI reaches the Cypher tab's console through the search store's request
 * (`requestNativeQuery`), and the console takes it once: it opens with the draft in it and waits
 * for Run — a draft is never run for the person. Draft with AI writes the request; it is offered
 * only while the assistant is set up.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/lib/queryClient'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useSearchStore } from '@/store/searchStore'

import { AiCypherDraft } from '../native/AiCypherDraft'
import { NativeConsole } from '../native/NativeConsole'

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProviderIfAvailable: () => provider,
}))

const runNativeQuery = vi.fn()
let provider: RemoteGraphProvider

beforeAll(() => {
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }
    Range.prototype.getClientRects = (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as never
    Range.prototype.getBoundingClientRect = (() => rect) as never
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const DRAFT = 'MATCH (d:Dataset)-[:FEEDS]->(x:Dashboard) WHERE "PII" IN d.tags RETURN d LIMIT 50'
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/v1/ai/status')) return json({ configured: true, personas: { data: true, help: true } })
    if (url.endsWith('/api/v1/ai/query/draft')) {
        return json({ mode: 'cypher', predicate: null, cypher: DRAFT, explanation: 'PII datasets that feed a dashboard.',
            assumptions: ['“PII” read as the tag PII'], clarification: null, guard: { ok: true } })
    }
    return json({})
})

const realFetch = globalThis.fetch
beforeEach(() => {
    runNativeQuery.mockReset()
    provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { runNativeQuery }) as RemoteGraphProvider
    useSearchStore.getState().clear()
    useSearchStore.setState({ pendingNativeQuery: null })
    queryClient.clear()
    fetchMock.mockClear()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: true } })
})
afterEach(() => { globalThis.fetch = realFetch })

const editorText = () => (document.querySelector('.cm-content') as HTMLElement | null)?.textContent


describe('the console takes Cypher drafted for it', () => {
    it('opens with the draft in it, takes it once, and does not run it', async () => {
        render(<NativeConsole viewId="v" engine="falkordb" seed={null} />)
        expect(editorText()).toBeUndefined()
        act(() => useSearchStore.getState().requestNativeQuery(DRAFT))
        await waitFor(() => expect(editorText()).toBe(DRAFT))
        expect(screen.getByText('Drafted with AI — read it through, then press Run.')).toBeInTheDocument()
        expect(useSearchStore.getState().pendingNativeQuery).toBeNull()
        expect(runNativeQuery).not.toHaveBeenCalled()
    })

    it('leaves the draft waiting while the console cannot run here', async () => {
        vi.useFakeTimers()
        try {
            render(<NativeConsole viewId="v" engine="falkordb" seed={null} unavailable="Switch to main." />)
            act(() => useSearchStore.getState().requestNativeQuery(DRAFT))
            await act(async () => { await vi.runAllTimersAsync() })
            expect(useSearchStore.getState().pendingNativeQuery).toBe(DRAFT)
            expect(editorText()).toBeUndefined()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('Draft with AI', () => {
    it('writes the Cypher into the console, says what it means and whether it may run', async () => {
        render(<><AiCypherDraft viewId="v" /><NativeConsole viewId="v" engine="falkordb" seed={null} /></>)
        fireEvent.click(await screen.findByRole('button', { name: /Draft with AI/ }))
        fireEvent.change(screen.getByRole('textbox', { name: 'The query you want, in plain words' }),
            { target: { value: 'PII datasets that feed a dashboard' } })
        fireEvent.click(screen.getByRole('button', { name: 'Draft' }))
        await waitFor(() => expect(editorText()).toBe(DRAFT))
        expect(screen.getByText('PII datasets that feed a dashboard.')).toBeInTheDocument()
        expect(screen.getByText('Assumed “PII” read as the tag PII')).toBeInTheDocument()
        expect(screen.getByText(/Read-only — it would be allowed to run/)).toBeInTheDocument()
        expect(runNativeQuery).not.toHaveBeenCalled()
        const body = JSON.parse(String(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/query/draft'))![1]!.body))
        expect(body).toMatchObject({ question: 'PII datasets that feed a dashboard', mode: 'cypher', context: { viewId: 'v' } })
    })

    it('is not offered while the assistant is off', () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: false } })
        render(<AiCypherDraft viewId="v" />)
        expect(screen.queryByRole('button', { name: /Draft with AI/ })).not.toBeInTheDocument()
    })
})
