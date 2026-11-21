/**
 * Who to ask about a source's data: named contacts, or the ones worked out while
 * nobody is named (and the card says so); Stewards editable by its managers, the Owner
 * only by admins or the current Owner; a concurrent change shows the newer version and keeps
 * the draft; a team of more than 50 is flagged before saving. There while conversations or
 * data source details are on; asking is conversations' alone.
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
const pick = vi.hoisted(() => ({ subject: { type: 'group', id: 'grp_fin', name: 'Finance data team', detail: '', memberCount: 6 } }))
vi.mock('@/components/serviceAccounts/SubjectPicker', () => ({
    subjectKey: (s: { type: string; id: string }) => `${s.type}:${s.id}`,
    SubjectPicker: ({ label, onPick }: { label: string; onPick: (s: typeof pick.subject) => void }) => (
        <button type="button" onClick={() => onPick(pick.subject)}>{label}</button>
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
    pick.subject = { type: 'group', id: 'grp_fin', name: 'Finance data team', detail: '', memberCount: 6 }
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

    it('keeps the draft when someone else changed them meanwhile, showing what they saved', async () => {
        api.get.mockResolvedValue(contacts())
        const theirs = contacts({
            stewards: [{ subjectType: 'user', subjectId: 'usr_ben', name: 'Ben Hall', memberCount: null, via: 'named_steward' }],
            updatedAt: '2026-11-20T10:00:00Z',
        })
        api.save.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, detail: { type: 'stale', current: theirs } }))
        renderCard()
        await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
        await userEvent.click(screen.getByRole('button', { name: 'Add a steward' }))
        await userEvent.click(screen.getByRole('button', { name: /Save contacts/ }))
        expect(await screen.findByText(/here’s the newer version/)).toBeInTheDocument()
        expect(screen.getByText('Ada Okafor (Owner), Ben Hall')).toBeInTheDocument()
        // Still editing, still with the steward they added; saving again is against the newer version.
        expect(screen.getByRole('list', { name: 'Stewards' })).toHaveTextContent('Finance data team')
        api.save.mockResolvedValueOnce(theirs)
        await userEvent.click(screen.getByRole('button', { name: /Save contacts/ }))
        await waitFor(() => expect(api.save).toHaveBeenLastCalledWith('ws_fin', 'ds_gl', expect.objectContaining({
            stewards: [{ subjectType: 'group', subjectId: 'grp_fin' }], expectedUpdatedAt: '2026-11-20T10:00:00Z',
        })))
    })

    it('warns before saving a team of more than 50, and will not send it', async () => {
        api.get.mockResolvedValue(contacts())
        pick.subject = { type: 'group', id: 'grp_all', name: 'All analysts', detail: '', memberCount: 140 }
        renderCard()
        await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
        await userEvent.click(screen.getByRole('button', { name: 'Add a steward' }))
        expect(screen.getByRole('alert')).toHaveTextContent('All analysts has 140 people — a team named here can have at most 50.')
        expect(screen.getByRole('button', { name: /Save contacts/ })).toBeDisabled()
        await userEvent.click(screen.getByRole('button', { name: 'Remove All analysts' }))
        expect(screen.queryByRole('alert')).toBeNull()
        expect(screen.getByRole('button', { name: /Save contacts/ })).toBeEnabled()
    })

    it('is editable with data source details on and conversations off, without the ask button', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: false, dataSourceMetadataEnabled: true } })
        api.get.mockResolvedValue(contacts())
        renderCard(vi.fn())
        expect(await screen.findByText('Ada Okafor')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Ask a question/ })).toBeNull()
    })

    it('stays hidden while both conversations and data source details are off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: false } })
        api.get.mockResolvedValue(contacts())
        renderCard()
        await new Promise(r => setTimeout(r, 20))
        expect(api.get).not.toHaveBeenCalled()
        expect(screen.queryByText('Who to ask about this data')).not.toBeInTheDocument()
    })
})
