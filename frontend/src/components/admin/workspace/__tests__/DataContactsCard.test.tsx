/**
 * Who to ask about a source's data: named contacts, or the ones worked out while
 * nobody is named (and the card says so); Stewards editable by its managers, the Owner
 * only by admins or the current Owner; a concurrent change reloads.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), save: vi.fn() } }))
vi.mock('@/services/dataSourceContactsService', async (orig) => ({
    ...(await orig<typeof import('@/services/dataSourceContactsService')>()),
    dataSourceContactsService: api,
}))
vi.mock('@/components/serviceAccounts/SubjectPicker', () => ({
    subjectKey: (s: { type: string; id: string }) => `${s.type}:${s.id}`,
    SubjectPicker: ({ label, onPick }: { label: string; onPick: (s: { type: string; id: string; name: string; detail: string }) => void }) => (
        <button type="button" onClick={() => onPick({ type: 'group', id: 'grp_fin', name: 'Finance data team', detail: '' })}>{label}</button>
    ),
}))

import { DataContactsCard } from '../DataContactsCard'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const ada = { id: 'usr_ada', displayName: 'Ada Okafor', email: 'ada@x.io', avatarId: null, hasImage: false, deleted: false }
const contacts = (over: Record<string, unknown> = {}) => ({
    owner: { subjectType: 'user', subjectId: 'usr_ada', name: 'Ada Okafor', memberCount: null, via: 'named_owner' },
    stewards: [], provenance: 'named', updatedAt: '2026-11-20T09:00:00Z', canEdit: true, canEditOwner: true,
    people: { usr_ada: ada }, ...over,
})

function renderCard(onAsk?: () => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><MemoryRouter><DataContactsCard wsId="ws_fin" dsId="ds_gl" onAsk={onAsk} /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
})
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

describe('DataContactsCard', () => {
    it('shows the named owner and offers to ask', async () => {
        api.get.mockResolvedValue(contacts())
        const onAsk = vi.fn()
        renderCard(onAsk)
        expect(await screen.findByText('Ada Okafor')).toBeInTheDocument()
        expect(screen.getByLabelText('Owner')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /Ask a question/ }))
        expect(onAsk).toHaveBeenCalled()
    })

    it('says when the contacts were worked out, and naming them writes them down', async () => {
        api.get.mockResolvedValue(contacts({
            provenance: 'derived',
            owner: { subjectType: 'user', subjectId: 'usr_ada', name: 'Ada Okafor', memberCount: null, via: 'created_source' },
            updatedAt: null,
        }))
        api.save.mockImplementation((_ws, _ds, body) => Promise.resolve(contacts({ stewards: [{ ...body.stewards[0], name: 'Finance data team', memberCount: 6, via: 'named_steward' }] })))
        renderCard()
        expect(await screen.findByText(/worked out from how it was connected/)).toBeInTheDocument()
        expect(screen.getByText(/Connected this source · suggested owner/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Name them' }))
        await userEvent.click(screen.getByRole('button', { name: 'Add a steward' }))
        await userEvent.click(screen.getByRole('button', { name: /Save contacts/ }))
        await waitFor(() => expect(api.save).toHaveBeenCalledWith('ws_fin', 'ds_gl', {
            owner: { subjectType: 'user', subjectId: 'usr_ada' },
            stewards: [{ subjectType: 'group', subjectId: 'grp_fin' }],
            expectedUpdatedAt: null,
        }))
        expect(await screen.findByText('Finance data team')).toBeInTheDocument()
    })

    it('locks the owner for someone who may only change the stewards', async () => {
        api.get.mockResolvedValue(contacts({ canEditOwner: false }))
        renderCard()
        await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
        expect(screen.queryByRole('button', { name: 'Remove Ada Okafor' })).not.toBeInTheDocument()
        expect(screen.getByText(/Only the workspace’s admins or the current Owner/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Add a steward' })).toBeInTheDocument()
    })

    it('reloads when someone else changed them meanwhile', async () => {
        api.get.mockResolvedValue(contacts())
        api.save.mockRejectedValue(Object.assign(new Error('stale'), { status: 409, detail: { type: 'stale' } }))
        renderCard()
        await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
        await userEvent.click(screen.getByRole('button', { name: /Save contacts/ }))
        await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
        expect(screen.queryByRole('button', { name: /Save contacts/ })).not.toBeInTheDocument()
    })

    it('stays hidden while conversations are off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: false } })
        api.get.mockResolvedValue(contacts())
        renderCard()
        await new Promise(r => setTimeout(r, 20))
        expect(api.get).not.toHaveBeenCalled()
        expect(screen.queryByText('Who to ask about this data')).not.toBeInTheDocument()
    })
})
