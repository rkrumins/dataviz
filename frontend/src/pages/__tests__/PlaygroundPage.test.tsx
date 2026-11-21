/**
 * /playground opens the Playground for anyone: someone not in it yet becomes a member on the way
 * (once), a member goes straight in, and while it is off or not set up the page says so.
 */
import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaygroundInfo } from '@/services/playgroundService'

const { state, join } = vi.hoisted(() => ({
    state: { info: undefined as PlaygroundInfo | undefined },
    join: vi.fn(),
}))
vi.mock('@/hooks/usePlayground', () => ({
    usePlayground: () => ({ data: state.info, isError: false, refetch: vi.fn() }),
    useJoinPlayground: () => ({ mutate: join, isError: false, reset: vi.fn() }),
}))
vi.mock('@/components/playground/PlaygroundCard', () => ({ PlaygroundCard: () => <p>set it up card</p> }))

import { PlaygroundPage } from '../PlaygroundPage'

const INFO: PlaygroundInfo = {
    enabled: true, exists: true, workspaceId: 'ws_play', name: 'Playground', joined: false,
    graphQuota: 5, graphsUsed: 0, canSetUp: false,
}

function renderPage() {
    return render(
        <StrictMode>
        <MemoryRouter initialEntries={['/playground']}>
            <Routes>
                <Route path="/playground" element={<PlaygroundPage />} />
                <Route path="/workspaces/:wsId" element={<p>the playground</p>} />
            </Routes>
        </MemoryRouter>
        </StrictMode>,
    )
}

beforeEach(() => {
    join.mockReset()
    state.info = undefined
})

describe('PlaygroundPage', () => {
    it('makes a newcomer a member once, then opens the Playground', async () => {
        state.info = INFO
        join.mockImplementation((_: unknown, opts: { onSuccess: (i: PlaygroundInfo) => void }) =>
            opts.onSuccess({ ...INFO, joined: true }))
        renderPage()   // StrictMode runs the effect twice: the person is still made a member once
        expect(await screen.findByText('the playground')).toBeInTheDocument()
        expect(join).toHaveBeenCalledTimes(1)
    })

    it('opens it straight away for a member, without joining again', async () => {
        state.info = { ...INFO, joined: true }
        renderPage()
        expect(await screen.findByText('the playground')).toBeInTheDocument()
        expect(join).not.toHaveBeenCalled()
    })

    it('says so while it isn’t set up, and offers an administrator to set it up', () => {
        state.info = { ...INFO, exists: false, workspaceId: null }
        const { unmount } = renderPage()
        expect(screen.getByText('The Playground isn’t open yet')).toBeInTheDocument()
        expect(join).not.toHaveBeenCalled()
        unmount()
        state.info = { ...INFO, exists: false, workspaceId: null, canSetUp: true }
        renderPage()
        expect(screen.getByText('set it up card')).toBeInTheDocument()
    })

    it('waits, branded, while it opens', () => {
        state.info = INFO
        renderPage()
        expect(screen.getByRole('status')).toHaveTextContent('Opening the Playground…')
    })
})
