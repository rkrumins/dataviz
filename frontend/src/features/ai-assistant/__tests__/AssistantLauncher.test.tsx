/**
 * The launcher bubble: there while the rail is folded away (and the assistant is set up), gone
 * while it is open; a click opens it; a dot and its name say when an answer is waiting; and it
 * reserves its height in the corner for the export tray and the notifications above it — and
 * gives it back when it goes.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryClient } from '@/lib/queryClient'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

import { AI_STATUS_KEY } from '../api/aiQueries'
import type { AiStatus } from '../api/types'
import { AssistantLauncher } from '../components/AssistantLauncher'
import { useAssistantStore } from '../store/assistantStore'

const VAR = '--assistant-launcher-height'
let status: AiStatus = { configured: true, personas: { data: true, help: true } }
const fetchMock = vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/api/v1/ai/status')
    ? new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response('{}', { status: 404 })))

const realFetch = globalThis.fetch
const initialStore = useAssistantStore.getState()
beforeEach(() => {
    queryClient.clear()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    status = { configured: true, personas: { data: true, help: true } }
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, aiAssistantEnabled: true } })
    useAssistantStore.setState({ ...initialStore, open: false }, true)
})
afterEach(() => {
    globalThis.fetch = realFetch
    document.documentElement.style.removeProperty(VAR)
})

const renderLauncher = () => render(<MemoryRouter initialEntries={['/dashboard']}><AssistantLauncher /></MemoryRouter>)
const bubble = () => screen.findByRole('button', { name: /^Open the assistant/ })

describe('AssistantLauncher', () => {
    it('opens the assistant, and is gone while it is open', async () => {
        renderLauncher()
        const button = await bubble()
        expect(button).toHaveAttribute('aria-keyshortcuts', expect.stringMatching(/^(Meta|Control)\+J$/))
        expect(button).toHaveTextContent('Ask about Dashboard')
        fireEvent.click(button)
        expect(useAssistantStore.getState().open).toBe(true)
        expect(screen.queryByRole('button', { name: /^Open the assistant/ })).not.toBeInTheDocument()
    })

    it('is not offered while the assistant has no model to answer with', async () => {
        status = { configured: false, personas: { data: true, help: true } }
        renderLauncher()
        await waitFor(() => expect(queryClient.getQueryState(AI_STATUS_KEY)?.status).toBe('success'))
        expect(screen.queryByRole('button', { name: /^Open the assistant/ })).not.toBeInTheDocument()
    })

    it('says when an answer is waiting, and opening it clears that', async () => {
        useAssistantStore.setState({ unread: true })
        const { container } = renderLauncher()
        const button = await bubble()
        expect(button).toHaveAccessibleName('Open the assistant — a new answer is ready')
        expect(container.querySelector('[data-unread]')).not.toBeNull()
        fireEvent.click(button)
        expect(useAssistantStore.getState().unread).toBe(false)
    })

    it('reserves its height in the corner, and withdraws it when it goes', async () => {
        renderLauncher()
        await bubble()
        // jsdom lays nothing out: the reservation is the gap alone, but it is there.
        expect(document.documentElement.style.getPropertyValue(VAR)).toBe('8px')
        act(() => useAssistantStore.getState().openAssistant())
        expect(document.documentElement.style.getPropertyValue(VAR)).toBe('')
    })
})
