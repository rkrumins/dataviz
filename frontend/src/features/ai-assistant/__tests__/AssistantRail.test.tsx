/**
 * The rail, end to end against a mocked service: it says when there is no model to answer with
 * (and, to an administrator, where to connect one); it starts from questions for where the
 * person is; a question streams its answer in — steps, words, cards, follow-ups — and Stop ends
 * it where it is. Its keys are its own: the composer sits in the `ai-chat` keyboard scope, Enter
 * asks, Shift+Enter is a new line, Esc closes.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KEYBOARD_SCOPE_ATTR } from '@/lib/keyboardScope'
import { queryClient } from '@/lib/queryClient'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

import type { AiStatus } from '../api/types'
import { AssistantRail } from '../components/AssistantRail'
import { stopStreaming } from '../lib/chatController'
import { useAssistantStore } from '../store/assistantStore'

const CONFIGURED: AiStatus = { configured: true, personas: { data: true, help: true }, connectionName: 'Corp gateway' }

const enc = new TextEncoder()
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** A streamed answer: `frames`, then — with `hold` — a connection left open until aborted. */
function sseResponse(frames: string[], { hold = false } = {}) {
    let i = 0
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < frames.length) { controller.enqueue(enc.encode(frames[i++])); return }
            if (!hold) controller.close()
            return hold ? new Promise(() => {}) : undefined
        },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let chat: (body: Record<string, unknown>) => Response
let status: AiStatus
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/v1/ai/status')) return json(status)
    if (url.endsWith('/api/v1/ai/chat/stream')) return chat(JSON.parse(String(init?.body)))
    if (url.includes('/api/v1/ai/conversations')) return json({ items: [] })
    return json({}, 404)
})

const realFetch = globalThis.fetch
const initialStore = useAssistantStore.getState()
beforeEach(() => {
    // The assistant's reads live on the app's one client: each test starts it empty.
    queryClient.clear()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    fetchMock.mockClear()
    status = CONFIGURED
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: true } })
    useAssistantStore.setState({ ...initialStore, open: true }, true)
})
afterEach(() => {
    stopStreaming()
    globalThis.fetch = realFetch
})

function renderRail(path = '/dashboard') {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <QueryClientProvider client={queryClient}>
                <div className="flex">
                    <main />
                    <AssistantRail />
                </div>
            </QueryClientProvider>
        </MemoryRouter>,
    )
}

const composer = () => screen.getByRole('textbox', { name: 'Ask the assistant' })

describe('AssistantRail', () => {
    it('says an administrator needs to connect a model — and offers an administrator the way there', async () => {
        status = { configured: false, personas: { data: true, help: true } }
        useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
        renderRail()
        expect(await screen.findByText('No AI model is connected yet')).toBeInTheDocument()
        expect(screen.getByText(/Administration → AI/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Set up the assistant' })).toBeInTheDocument()
        expect(composer()).toBeDisabled()
    })

    it('keeps its keys: the composer sits in the ai-chat keyboard scope', async () => {
        renderRail()
        await screen.findByText('Ask about your data')
        expect(composer().closest(`[${KEYBOARD_SCOPE_ATTR}]`)?.getAttribute(KEYBOARD_SCOPE_ATTR)).toBe('ai-chat')
    })

    it('starts from questions for where the person is, and for Help', async () => {
        renderRail()
        expect(await screen.findByRole('button', { name: /Do we have views about supply-chain failures\?/ })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Help' }))
        expect(screen.getByRole('button', { name: /How do I share a view\?/ })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /What is a data source\?/ })).toBeInTheDocument()
    })

    it('streams an answer in: how it got there, the words, the cards and what to ask next', async () => {
        chat = () => sseResponse([
            frame('meta', { conversationId: 'conv_1', messageId: 'msg_1', persona: 'data', contractVersion: 1 }),
            frame('step', { id: 's1', label: 'Searching for PII columns', status: 'running' }),
            ': keep-alive\n\n',
            frame('step', { id: 's1', label: 'Searching for PII columns', status: 'done', detail: '214 found' }),
            frame('text', { delta: 'I found **214** PII columns' }),
            frame('text', { delta: ' updated in the last 7 days.' }),
            frame('block', { id: 'b1', type: 'results', data: {
                title: 'PII columns updated in the last 7 days', total: 214, totalExact: true,
                byType: [{ type: 'schemaField', label: 'Column', count: 214 }],
                items: [{ urn: 'urn:c1', name: 'email', type: 'schemaField', path: ['Snowflake', 'crm'] }],
                viewId: 'v1',
            } }),
            frame('followups', ['Who owns these?']),
            frame('done', { status: 'ok' }),
        ])
        renderRail()
        await screen.findByText('Ask about your data')
        fireEvent.change(composer(), { target: { value: 'Which PII columns changed last week?' } })
        fireEvent.keyDown(composer(), { key: 'Enter' })

        const answer = await screen.findByRole('article', { name: 'Answer' })
        await waitFor(() => expect(within(answer).getByText('Who owns these?')).toBeInTheDocument())
        expect(within(answer).getByText('214', { selector: 'strong' })).toBeInTheDocument()
        expect(within(answer).getByRole('region', { name: 'PII columns updated in the last 7 days' })).toBeInTheDocument()
        expect(within(answer).getByRole('button', { name: /How I got this/ })).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByText('Which PII columns changed last week?')).toBeInTheDocument()
        expect(useAssistantStore.getState().conversationId).toBe('conv_1')
        expect(within(answer).getByRole('button', { name: 'Helpful' })).toBeInTheDocument()

        const sent = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/chat/stream'))!
        expect(JSON.parse(String(sent[1]!.body))).toMatchObject({
            message: 'Which PII columns changed last week?', persona: 'data',
            context: { route: '/dashboard', personaMode: 'technical' },
        })
        expect(JSON.parse(String(sent[1]!.body))).not.toHaveProperty('conversationId')
    })

    it('a follow-up continues the same conversation', async () => {
        chat = () => sseResponse([
            frame('meta', { conversationId: 'conv_7', messageId: 'm', persona: 'data', contractVersion: 1 }),
            frame('text', { delta: 'Done.' }),
            frame('followups', ['And last month?']),
            frame('done', { status: 'ok' }),
        ])
        renderRail()
        await screen.findByText('Ask about your data')
        fireEvent.change(composer(), { target: { value: 'First' } })
        fireEvent.keyDown(composer(), { key: 'Enter' })
        fireEvent.click(await screen.findByRole('button', { name: 'And last month?' }))
        await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/chat/stream'))).toHaveLength(2))
        const second = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/chat/stream'))[1]
        expect(JSON.parse(String(second[1]!.body))).toMatchObject({ conversationId: 'conv_7', message: 'And last month?' })
    })

    it('Shift+Enter is a new line, not a question', async () => {
        renderRail()
        await screen.findByText('Ask about your data')
        fireEvent.change(composer(), { target: { value: 'two' } })
        fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true })
        expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/chat/stream'))).toBe(false)
    })

    it('shows the thinking shimmer, then Stop ends the answer where it is', async () => {
        chat = () => sseResponse([
            frame('meta', { conversationId: 'c', messageId: 'm', persona: 'data', contractVersion: 1 }),
            frame('step', { id: 's1', label: 'Walking the lineage', status: 'running' }),
        ], { hold: true })
        renderRail()
        await screen.findByText('Ask about your data')
        fireEvent.change(composer(), { target: { value: 'What breaks?' } })
        fireEvent.keyDown(composer(), { key: 'Enter' })
        expect(await screen.findByText('Walking the lineage…')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Stop the answer' }))
        expect(await screen.findByText(/Stopped — what arrived is above/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    })

    it('says plainly when a turn fails, and offers to try again', async () => {
        chat = () => sseResponse([
            frame('meta', { conversationId: 'c', messageId: 'm', persona: 'data', contractVersion: 1 }),
            frame('error', { code: 'busy', message: 'Another turn is running.' }),
            frame('done', { status: 'error' }),
        ])
        renderRail()
        await screen.findByText('Ask about your data')
        fireEvent.change(composer(), { target: { value: 'Hi' } })
        fireEvent.keyDown(composer(), { key: 'Enter' })
        expect(await screen.findByRole('alert')).toHaveTextContent('The assistant is busy')
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    })

    it('answers a clarification with the option chosen, in the same conversation', async () => {
        chat = (body) => (body.clarification
            ? sseResponse([frame('text', { delta: 'Using the tag.' }), frame('done', { status: 'ok' })])
            : sseResponse([
                frame('meta', { conversationId: 'conv_c', messageId: 'm', persona: 'data', contractVersion: 1 }),
                frame('clarify', { id: 'clr_1', question: 'Which means PII?', allowRemember: true,
                    options: [{ id: 'opt_1', label: 'Tag “pii”', count: 312 }, { id: 'opt_2', label: 'personal_data', count: 290 }] }),
                frame('done', { status: 'clarify' }),
            ]))
        renderRail()
        await screen.findByText('Ask about your data')
        fireEvent.change(composer(), { target: { value: 'Which tables hold PII?' } })
        fireEvent.keyDown(composer(), { key: 'Enter' })
        fireEvent.click(await screen.findByRole('radio', { name: /Tag “pii”/ }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'Remember for this data source' }))
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
        await screen.findByText('Using the tag.')
        const second = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/chat/stream'))[1]
        expect(JSON.parse(String(second[1]!.body))).toMatchObject({
            conversationId: 'conv_c', message: '', clarification: { id: 'clr_1', optionId: 'opt_1', remember: true },
        })
        // The question asks no more, and says what was chosen.
        expect(screen.queryByRole('radio', { name: /Tag “pii”/ })).not.toBeInTheDocument()
        expect(screen.getAllByText('Tag “pii”').length).toBeGreaterThan(0)
    })

    it('Esc closes it', async () => {
        renderRail()
        await screen.findByText('Ask about your data')
        act(() => { fireEvent.keyDown(composer(), { key: 'Escape' }) })
        expect(useAssistantStore.getState().open).toBe(false)
    })
})
