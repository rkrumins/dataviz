/**
 * What a data source is and whether to rely on it: its own description, else the catalog's
 * (and it says so); links that open safely; tags; its status with who set it; how it got
 * here. Editing is for those the server says may — details for its managers, the status for
 * its Owner, Stewards and admins — and a save someone else beat keeps the draft beside the
 * newer version. Nothing at all while the switch is off.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSourceMetadata } from '@/services/dataSourceMetadataService'

const api = vi.hoisted(() => ({ get: vi.fn(), saveDetails: vi.fn(), saveTrust: vi.fn(), listActivity: vi.fn() }))
const contactsApi = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }))
vi.mock('@/services/dataSourceMetadataService', async (orig) => ({
    ...(await orig<typeof import('@/services/dataSourceMetadataService')>()),
    dataSourceMetadataService: api,
}))
vi.mock('@/services/dataSourceContactsService', async (orig) => ({
    ...(await orig<typeof import('@/services/dataSourceContactsService')>()),
    dataSourceContactsService: contactsApi,
}))

import { AboutDataSourceCard } from '../AboutDataSourceCard'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const ada = { id: 'usr_ada', displayName: 'Ada Okafor', email: null, avatarId: null, hasImage: false, deleted: false }
const meta = (over: Partial<DataSourceMetadata> = {}): DataSourceMetadata => ({
    dataSourceId: 'ds_gl', description: null, catalogDescription: null, links: [], tags: [],
    classification: null, trustStatus: null, trustNote: null, trustStatusBy: null, trustStatusAt: null,
    updatedAt: '2026-11-18T09:00:00Z', updatedBy: ada,
    onboarding: { at: null, by: null, how: null, fromRequest: null },
    canEdit: false, canEditTrust: false, ...over,
})

function renderCard(props: Partial<React.ComponentProps<typeof AboutDataSourceCard>> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={client}><MemoryRouter>
        <AboutDataSourceCard wsId="ws_fin" dsId="ds_gl" {...props} />
    </MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
    vi.clearAllMocks()
    contactsApi.get.mockResolvedValue({ owner: null, stewards: [], provenance: 'named', updatedAt: null, canEdit: true, canEditOwner: true, people: {} })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, dataSourceMetadataEnabled: true } })
})
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } }))

describe('AboutDataSourceCard — reading', () => {
    it('shows the catalog’s description, captioned, when the source has none of its own', async () => {
        api.get.mockResolvedValue(meta({ catalogDescription: 'The general ledger, as finance keeps it.' }))
        renderCard()
        expect(await screen.findByText('The general ledger, as finance keeps it.')).toBeInTheDocument()
        expect(screen.getByText('From the catalog')).toBeInTheDocument()
    })

    it('prefers its own description, uncaptioned', async () => {
        api.get.mockResolvedValue(meta({ description: 'Ours.', catalogDescription: 'Theirs.' }))
        renderCard()
        expect(await screen.findByText('Ours.')).toBeInTheDocument()
        expect(screen.queryByText('Theirs.')).toBeNull()
        expect(screen.queryByText('From the catalog')).toBeNull()
    })

    it('opens web links in a new tab, safely, and never follows anything else', async () => {
        api.get.mockResolvedValue(meta({ links: [
            { label: 'Runbook', url: 'https://wiki.example.com/gl' },
            { label: 'Sneaky', url: 'javascript:alert(1)' },
        ] }))
        renderCard()
        const runbook = await screen.findByRole('link', { name: /Runbook/ })
        expect(runbook).toHaveAttribute('href', 'https://wiki.example.com/gl')
        expect(runbook).toHaveAttribute('target', '_blank')
        expect(runbook).toHaveAttribute('rel', 'noopener noreferrer')
        expect(screen.getByText('Sneaky')).toBeInTheDocument()
        expect(screen.queryByRole('link', { name: /Sneaky/ })).toBeNull()
    })

    it('shows the status, who set it, the note, the tags and how it got here', async () => {
        const onShowRequests = vi.fn()
        api.get.mockResolvedValue(meta({
            trustStatus: 'deprecated', classification: 'confidential', trustNote: 'Use Ledger v2 instead',
            trustStatusBy: ada, trustStatusAt: '2026-11-10T09:00:00Z', tags: ['finance', 'month-end'],
            onboarding: { at: '2026-11-03T09:00:00Z', by: { ...ada, id: 'usr_ana', displayName: 'Ana Ruiz' }, how: 'catalog',
                fromRequest: { id: 'dr_1', title: 'Finance marts', requesterName: 'Sam Reader', requestedAt: '2026-11-01T09:00:00Z', connectedAt: '2026-11-03T09:00:00Z' } },
        }))
        renderCard({ onShowRequests })
        expect(await screen.findByText('Deprecated')).toBeInTheDocument()
        expect(screen.getByText('Confidential')).toBeInTheDocument()
        expect(screen.getByText(/^Deprecated\s*by/)).toBeInTheDocument()
        expect(screen.getByText('Use Ledger v2 instead')).toBeInTheDocument()
        expect(within(screen.getByRole('list', { name: 'Tags' })).getAllByRole('listitem').map(li => li.textContent)).toEqual(['finance', 'month-end'])
        expect(screen.getByText('Ana Ruiz')).toBeInTheDocument()
        expect(screen.getByText('· From the catalog')).toBeInTheDocument()
        expect(screen.getByText('· asked by Sam Reader')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: '‘Finance marts’' }))
        expect(onShowRequests).toHaveBeenCalled()
        expect(screen.getByText(/Details last edited/)).toBeInTheDocument()
    })

    it('is not there at all while the switch is off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
        api.get.mockResolvedValue(meta())
        renderCard()
        await new Promise(r => setTimeout(r, 20))
        expect(api.get).not.toHaveBeenCalled()
        expect(screen.queryByText('About this data')).toBeNull()
    })
})

describe('AboutDataSourceCard — who may edit what', () => {
    it('offers neither form to a reader', async () => {
        api.get.mockResolvedValue(meta())
        renderCard()
        await screen.findByText('About this data')
        expect(screen.queryByRole('button', { name: /Edit details/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /Change status/ })).toBeNull()
    })

    it('offers the details to its managers — and, while nobody is named, says who could certify it', async () => {
        api.get.mockResolvedValue(meta({ canEdit: true }))
        contactsApi.get.mockResolvedValue({ owner: null, stewards: [], provenance: 'derived', updatedAt: null, canEdit: true, canEditOwner: true, people: {} })
        renderCard()
        expect(await screen.findByRole('button', { name: /Edit details/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Change status/ })).toBeNull()
        expect(await screen.findByText('Name an Owner or Stewards so they can certify it.')).toBeInTheDocument()
    })

    it('offers the status to its Owner, Stewards and admins', async () => {
        api.get.mockResolvedValue(meta({ canEditTrust: true }))
        renderCard()
        expect(await screen.findByRole('button', { name: /Change status/ })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Edit details/ })).toBeNull()
        expect(contactsApi.get).not.toHaveBeenCalled()
    })
})

describe('AboutDataSourceCard — saving', () => {
    it('saves the description, links and tags against the version it read', async () => {
        const user = userEvent.setup()
        api.get.mockResolvedValue(meta({ canEdit: true }))
        api.saveDetails.mockImplementation((_ws, _ds, body) => Promise.resolve(meta({ ...body, canEdit: true })))
        renderCard({ tagSuggestions: ['finance'] })
        await user.click(await screen.findByRole('button', { name: /Edit details/ }))
        await user.type(screen.getByLabelText('Description'), 'The ledger.')
        await user.click(screen.getByRole('button', { name: /Add a link/ }))
        await user.type(screen.getByLabelText('Link 1 name'), 'Runbook')
        await user.type(screen.getByLabelText('Link 1 address'), 'ftp://x')
        expect(screen.getByText('A link starts with https:// or http://.')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /Save details/ })).toBeDisabled()
        await user.clear(screen.getByLabelText('Link 1 address'))
        await user.type(screen.getByLabelText('Link 1 address'), 'https://wiki.example.com')
        await user.click(screen.getByRole('combobox', { name: 'Tags' }))
        await user.click(screen.getByRole('option', { name: 'finance' }))
        await user.click(screen.getByRole('button', { name: /Save details/ }))
        await waitFor(() => expect(api.saveDetails).toHaveBeenCalledWith('ws_fin', 'ds_gl', {
            description: 'The ledger.', links: [{ label: 'Runbook', url: 'https://wiki.example.com' }], tags: ['finance'],
            expectedUpdatedAt: '2026-11-18T09:00:00Z',
        }))
        expect(await screen.findByText('The ledger.')).toBeInTheDocument()
    })

    it('keeps the draft when someone saved first, beside their newer version', async () => {
        const user = userEvent.setup()
        api.get.mockResolvedValue(meta({ canEdit: true }))
        const newer = meta({ canEdit: true, description: 'Their words.', tags: ['gl'], updatedAt: '2026-11-19T09:00:00Z' })
        api.saveDetails.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, detail: { type: 'stale', current: newer } }))
        renderCard()
        await user.click(await screen.findByRole('button', { name: /Edit details/ }))
        await user.type(screen.getByLabelText('Description'), 'My words.')
        await user.click(screen.getByRole('button', { name: /Save details/ }))
        expect(await screen.findByText('Someone changed this — here’s the newer version.')).toBeInTheDocument()
        expect(screen.getByText('Their words.')).toBeInTheDocument()
        expect(screen.getByLabelText('Description')).toHaveValue('My words.')

        // Saving again is against their version.
        api.saveDetails.mockResolvedValueOnce(meta({ canEdit: true, description: 'My words.' }))
        await user.click(screen.getByRole('button', { name: /Save details/ }))
        await waitFor(() => expect(api.saveDetails).toHaveBeenLastCalledWith('ws_fin', 'ds_gl', expect.objectContaining({
            description: 'My words.', expectedUpdatedAt: '2026-11-19T09:00:00Z',
        })))
    })

    it('can start again from their version instead', async () => {
        const user = userEvent.setup()
        api.get.mockResolvedValue(meta({ canEdit: true }))
        api.saveDetails.mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, detail: {
            type: 'stale', current: meta({ canEdit: true, description: 'Their words.', updatedAt: '2026-11-19T09:00:00Z' }) } }))
        renderCard()
        await user.click(await screen.findByRole('button', { name: /Edit details/ }))
        await user.type(screen.getByLabelText('Description'), 'My words.')
        await user.click(screen.getByRole('button', { name: /Save details/ }))
        await user.click(await screen.findByRole('button', { name: 'Use theirs' }))
        expect(screen.getByLabelText('Description')).toHaveValue('Their words.')
        expect(screen.queryByText(/here’s the newer version/)).toBeNull()
    })

    it('changes the status, sensitivity and note', async () => {
        const user = userEvent.setup()
        api.get.mockResolvedValue(meta({ canEditTrust: true }))
        api.saveTrust.mockImplementation((_ws, _ds, body) => Promise.resolve(meta({ ...body, canEditTrust: true })))
        renderCard()
        await user.click(await screen.findByRole('button', { name: /Change status/ }))
        await user.click(screen.getByRole('radio', { name: /Deprecated/ }))
        expect(screen.getByLabelText('Note')).toHaveAttribute('placeholder', 'Use … instead')
        await user.click(screen.getByRole('radio', { name: 'Restricted' }))
        expect(screen.getByText(/Not the same as restricted publishing/)).toBeInTheDocument()
        await user.type(screen.getByLabelText('Note'), 'Use Ledger v2 instead')
        await user.click(screen.getByRole('button', { name: /Save status/ }))
        await waitFor(() => expect(api.saveTrust).toHaveBeenCalledWith('ws_fin', 'ds_gl', {
            trustStatus: 'deprecated', classification: 'restricted', trustNote: 'Use Ledger v2 instead', expectedUpdatedAt: '2026-11-18T09:00:00Z',
        }))
    })

    it('says why the server refused', async () => {
        const user = userEvent.setup()
        api.get.mockResolvedValue(meta({ canEditTrust: true }))
        api.saveTrust.mockRejectedValue(Object.assign(new Error('nope'), { status: 403, detail: { type: 'not_steward', message: 'Only its Owner or Stewards can change this.' } }))
        renderCard()
        await user.click(await screen.findByRole('button', { name: /Change status/ }))
        await user.click(screen.getByRole('radio', { name: /Certified/ }))
        await user.click(screen.getByRole('button', { name: /Save status/ }))
        expect(await screen.findByRole('alert')).toHaveTextContent('Only its Owner or Stewards can change this.')
    })
})
