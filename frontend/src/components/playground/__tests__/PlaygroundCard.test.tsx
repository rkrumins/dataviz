/**
 * The Playground card offers each person their one next step: nothing while the
 * switch is off, Try the Playground before they've joined (and opens it once they
 * have), Open the Playground after, and — for a platform administrator before
 * there is one — Set it up.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaygroundInfo } from '@/services/playgroundService'

const { state, join } = vi.hoisted(() => ({
    state: { info: undefined as PlaygroundInfo | undefined },
    join: vi.fn(),
}))
vi.mock('@/hooks/usePlayground', () => ({
    usePlayground: () => ({ data: state.info }),
    useJoinPlayground: () => ({ mutate: join, isPending: false }),
}))
vi.mock('../PlaygroundSetupDialog', () => ({
    PlaygroundSetupDialog: () => <div role="dialog" aria-label="Set up the Playground" />,
}))

import { PlaygroundCard } from '../PlaygroundCard'

const INFO: PlaygroundInfo = {
    enabled: true, exists: true, workspaceId: 'ws_play', name: 'Playground', joined: false,
    graphQuota: 5, graphsUsed: 0, canSetUp: false,
}

function renderCard() {
    render(
        <MemoryRouter initialEntries={['/dashboard']}>
            <Routes>
                <Route path="/dashboard" element={<PlaygroundCard />} />
                <Route path="/workspaces/:wsId" element={<p>playground page</p>} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    state.info = undefined
})

describe('PlaygroundCard', () => {
    it('shows nothing while the Playground is off', () => {
        state.info = { ...INFO, enabled: false }
        renderCard()
        expect(screen.queryByRole('region')).not.toBeInTheDocument()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('shows nothing when there is no Playground and the reader cannot set one up', () => {
        state.info = { ...INFO, exists: false, workspaceId: null }
        renderCard()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('offers to join, and opens the Playground once joined', async () => {
        const user = userEvent.setup()
        state.info = INFO
        join.mockImplementation((_: unknown, opts: { onSuccess: (i: PlaygroundInfo) => void }) =>
            opts.onSuccess({ ...INFO, joined: true }))
        renderCard()
        expect(screen.getByText(/up to 5 graphs each/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Try the Playground/ }))
        expect(join).toHaveBeenCalledTimes(1)
        expect(await screen.findByText('playground page')).toBeInTheDocument()
    })

    it('opens it for a member, with what they have used', async () => {
        const user = userEvent.setup()
        state.info = { ...INFO, joined: true, graphsUsed: 2 }
        renderCard()
        expect(screen.getByText(/2 of 5 graphs used/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Try the Playground/ })).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Open the Playground/ }))
        expect(await screen.findByText('playground page')).toBeInTheDocument()
    })

    it('lets a platform administrator set one up before there is one', async () => {
        const user = userEvent.setup()
        state.info = { ...INFO, exists: false, workspaceId: null, canSetUp: true }
        renderCard()
        expect(screen.getByRole('heading', { name: 'Set up a Playground' })).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Set it up/ }))
        expect(screen.getByRole('dialog', { name: 'Set up the Playground' })).toBeInTheDocument()
    })
})
