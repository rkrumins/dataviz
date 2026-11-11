/**
 * The "Draft retention" card on Admin → Infrastructure → Versioned graphs: how long a merged or
 * abandoned draft keeps its changes, with the window in force and its default, Reset to default
 * (which saves null), and a confirmation before a window that removes more than the one in force.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { draftRetention, saveDraftRetention } = vi.hoisted(() => ({
    draftRetention: vi.fn(),
    saveDraftRetention: vi.fn(),
}))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return {
        ...actual,
        systemStatusService: { ...actual.systemStatusService, draftRetention, saveDraftRetention },
    }
})

import { DraftRetentionCard } from './DraftRetentionCard'
import type { DraftRetention } from '@/services/systemStatusService'

function retention(over: Partial<DraftRetention> = {}): DraftRetention {
    return { days: 30, saved: null, default: 30, min: 0, max: 3650, ...over }
}

function renderCard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><DraftRetentionCard /></QueryClientProvider>)
}

const LABEL = "Keep a closed draft's changes for"

beforeEach(() => {
    draftRetention.mockReset().mockResolvedValue(retention())
    saveDraftRetention.mockReset().mockResolvedValue(retention())
})

describe('DraftRetentionCard', () => {
    it('says the window in force, its default, and what a draft keeps', async () => {
        draftRetention.mockResolvedValue(retention({ days: 45, saved: 45 }))
        renderCard()
        const group = await screen.findByRole('group', { name: LABEL })
        expect(within(group).getByRole('spinbutton')).toHaveValue(45)
        expect(group).toHaveTextContent('Default: 30 days')
        expect(screen.getByText(/keeps its changes 45 days, then they are removed/)).toBeInTheDocument()
        expect(screen.getByText(/Its name, owner, commits and review stay/)).toBeInTheDocument()
    })

    it('saves a longer window at once, with nothing to confirm', async () => {
        renderCard()
        const input = within(await screen.findByRole('group', { name: LABEL })).getByRole('spinbutton')
        await userEvent.clear(input)
        await userEvent.type(input, '90')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(saveDraftRetention).toHaveBeenCalledWith(90))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('asks before a shorter window, and says what it removes and what stays', async () => {
        renderCard()
        const input = within(await screen.findByRole('group', { name: LABEL })).getByRole('spinbutton')
        await userEvent.clear(input)
        await userEvent.type(input, '7')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent('every draft merged or abandoned more than 7 days ago loses its changes')
        expect(dialog).toHaveTextContent("They can't be brought back")
        expect(saveDraftRetention).not.toHaveBeenCalled()
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save and remove' }))
        await waitFor(() => expect(saveDraftRetention).toHaveBeenCalledWith(7))
    })

    it('asks before a window where changes were kept for good', async () => {
        draftRetention.mockResolvedValue(retention({ days: 0, saved: 0 }))
        renderCard()
        expect(await screen.findByText(/keep their changes for good/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(await screen.findByRole('dialog')).toHaveTextContent('more than 30 days ago')
        await userEvent.click(screen.getByRole('button', { name: 'Save and remove' }))
        await waitFor(() => expect(saveDraftRetention).toHaveBeenCalledWith(null))
    })

    it('refuses a value out of range before anything is sent', async () => {
        renderCard()
        const input = within(await screen.findByRole('group', { name: LABEL })).getByRole('spinbutton')
        await userEvent.clear(input)
        await userEvent.type(input, '4000')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        expect(await screen.findByText('Enter a whole number of days from 0 to 3,650.')).toBeInTheDocument()
        expect(saveDraftRetention).not.toHaveBeenCalled()
    })
})
