/**
 * Following and answering data requests. A workspace's list shows where each stands — Asked, In
 * progress, Connected, Declined — and lets the person who asked withdraw one nobody has taken;
 * the platform team's queue opens one to start (assign me), connect (a source of that workspace's,
 * one added there and then, or none) or decline with a reason. The workspace's admins review its
 * requests too, and a source's named Owner or Steward connects one to a source of theirs and
 * nothing else; nobody answers their own. With the switch off, nothing shows.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataRequest } from '@/services/dataRequestsService'

const api = vi.hoisted(() => ({
    listForWorkspace: vi.fn(), listToAnswer: vi.fn(), withdraw: vi.fn(), start: vi.fn(), connect: vi.fn(), decline: vi.fn(),
}))
const ws = vi.hoisted(() => ({ get: vi.fn() }))
const people = vi.hoisted(() => ({ profile: vi.fn() }))
vi.mock('@/services/peopleService', () => ({ peopleService: people }))
vi.mock('@/services/dataRequestsService', async (orig) => {
    const real = await orig<typeof import('@/services/dataRequestsService')>()
    return { ...real, dataRequestsService: { ...real.dataRequestsService, ...api } }
})
vi.mock('@/services/workspaceService', async (orig) => {
    const real = await orig<typeof import('@/services/workspaceService')>()
    return { ...real, workspaceService: { ...real.workspaceService, ...ws } }
})
// Add source is its own wizard: here it adds "Ledger" the moment it opens.
vi.mock('@/components/admin/workspace/AddDataSourceWizard', () => ({
    AddDataSourceWizard: ({ onAdded, onClose }: { onAdded: () => void; onClose: () => void }) => (
        <div role="dialog" aria-label="Add source">
            <button type="button" onClick={() => { onAdded(); onClose() }}>add Ledger</button>
        </div>
    ),
}))

import { WorkspaceDataRequestsPanel } from '../WorkspaceDataRequestsPanel'
import { DataRequestsPanel } from '../DataRequestsPanel'
import { AskForDataButton, AskForDataPrompt } from '../AskForData'
import { useAuthStore } from '@/store/auth'
import { useNotificationStore } from '@/components/ui/notifications'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const T = new Date(Date.now() - 3 * 86_400_000).toISOString()
const row = (id: string, over: Partial<DataRequest>): DataRequest => ({
    id, workspaceId: 'ws_fin', workspaceName: 'Finance', requestedBy: 'usr_ada', requesterName: 'Ada Okafor',
    title: id, system: 'snowflake', urgency: 'no_rush', contactIds: [], status: 'pending', createdAt: T, ...over,
})
const MARTS = row('dr_marts', {
    title: 'Finance marts', requestedBy: 'usr_me', urgency: 'this_week', details: 'FIN_DB.MARTS',
    purpose: 'The March audit', contacts: [{ id: 'usr_ben', displayName: 'Ben Hall' }],
})
const DBT = row('dr_dbt', { title: 'dbt core', system: 'dbt', status: 'in_progress', assigneeId: 'usr_olga', assigneeName: 'Olga' })
const FILE = row('dr_file', { title: 'Inventory', system: 'file', status: 'connected', dataSourceId: 'ds_gl', dataSourceLabel: 'General ledger' })
const CRM = row('dr_crm', { title: 'CRM', system: 'other', status: 'declined', resolutionNote: 'Sales already has it' })

function wrap(ui: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
}

function as(global: string[], wsPerms: string[], id = 'usr_me') {
    useAuthStore.setState({
        user: { id, firstName: 'Sam', lastName: 'Reader', email: 'sam@example.com' },
        permissions: { global, ws: { ws_fin: wsPerms } },
    } as never)
}

/** The data this reader is a named Owner or Steward of. */
const looksAfter = (...ids: string[]) => people.profile.mockResolvedValue({
    person: { id: 'usr_me' }, isMe: true, workspacesTheyRun: [],
    dataContacts: ids.map(id => ({ dataSourceId: id, dataSourceName: id, workspaceId: 'ws_fin', workspaceName: 'Finance', role: 'steward', via: 'direct' })),
})

beforeEach(() => {
    for (const fn of [...Object.values(api), ...Object.values(ws), ...Object.values(people)]) fn.mockReset()
    looksAfter()
    api.listForWorkspace.mockResolvedValue([MARTS, DBT, FILE, CRM])
    api.listToAnswer.mockResolvedValue([MARTS, DBT])
    api.withdraw.mockResolvedValue({ ...MARTS, status: 'withdrawn' })
    api.start.mockResolvedValue({ ...MARTS, status: 'in_progress', assigneeId: 'usr_me', assigneeName: 'Sam Reader' })
    api.connect.mockResolvedValue({ ...MARTS, status: 'connected', dataSourceId: 'ds_ledger', dataSourceLabel: 'Ledger' })
    api.decline.mockResolvedValue({ ...MARTS, status: 'declined' })
    ws.get.mockResolvedValue({ id: 'ws_fin', name: 'Finance', dataSources: [{ id: 'ds_gl', label: 'General ledger', graphName: 'gl' }] })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, dataRequestsEnabled: true } })
    as([], ['workspace:datasource:read'])
})

describe('WorkspaceDataRequestsPanel', () => {
    it('shows where each request stands, and lets the asker withdraw theirs while nobody has taken it', async () => {
        const user = userEvent.setup()
        wrap(<WorkspaceDataRequestsPanel workspaceId="ws_fin" />)
        const marts = (await screen.findByText('Finance marts')).closest('li')!
        expect(within(marts).getByText('Asked')).toBeInTheDocument()
        expect(within(marts).getByText('This week')).toBeInTheDocument()
        expect(within(marts).getByText(/asked by you/)).toBeInTheDocument()
        expect(within(marts).getByText('In progress — next')).toBeInTheDocument()        // the stepper
        const dbt = screen.getByText('dbt core').closest('li')!
        expect(within(dbt).getByText('In progress')).toBeInTheDocument()
        expect(within(dbt).getByText(/Olga is on it/)).toBeInTheDocument()
        const file = screen.getByText('Inventory').closest('li')!
        expect(within(file).getByText(/connected as General ledger/)).toBeInTheDocument()
        expect(within(file).getByText('Connected — done')).toBeInTheDocument()
        const crm = screen.getByText('CRM').closest('li')!
        expect(within(crm).getAllByText('Declined').length).toBeGreaterThan(0)
        expect(within(crm).getByText('“Sales already has it”')).toBeInTheDocument()
        expect(screen.getByText('2 open')).toBeInTheDocument()

        // Only their own, only while waiting; a reader can't review.
        expect(screen.getAllByRole('button', { name: /^Withdraw/ })).toHaveLength(1)
        expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull()
        await user.click(within(marts).getByRole('button', { name: 'Withdraw Finance marts' }))
        expect(api.withdraw).toHaveBeenCalledWith('dr_marts')
    })

    it('offers Review to the workspace’s admins on the open ones — never on their own', async () => {
        as([], ['workspace:datasource:read', 'workspace:admin'])
        wrap(<WorkspaceDataRequestsPanel workspaceId="ws_fin" />)
        await screen.findByText('Finance marts')
        expect(screen.getAllByRole('button', { name: /^Review/ }).map(b => b.getAttribute('aria-label'))).toEqual(['Review dbt core'])
        expect(people.profile).not.toHaveBeenCalled()
    })

    it('no longer offers it for managing the sources alone', async () => {
        as([], ['workspace:datasource:read', 'workspace:datasource:manage'])
        wrap(<WorkspaceDataRequestsPanel workspaceId="ws_fin" />)
        await screen.findByText('Finance marts')
        await waitFor(() => expect(people.profile).toHaveBeenCalledWith('usr_me'))
        expect(screen.queryByRole('button', { name: /^Review/ })).toBeNull()
    })

    it('lets a source’s named Steward connect a request to a source of theirs, and nothing else', async () => {
        const user = userEvent.setup()
        as([], ['workspace:datasource:read', 'workspace:datasource:manage'])
        looksAfter('ds_gl')
        ws.get.mockResolvedValue({ id: 'ws_fin', name: 'Finance', dataSources: [
            { id: 'ds_gl', label: 'General ledger', graphName: 'gl' }, { id: 'ds_crm', label: 'CRM', graphName: 'crm' },
        ] })
        wrap(<WorkspaceDataRequestsPanel workspaceId="ws_fin" />)
        await user.click(await screen.findByRole('button', { name: 'Review dbt core' }))
        const drawer = screen.getByRole('dialog', { name: 'dbt core' })
        expect(within(drawer).queryByRole('button', { name: /Start — assign me/ })).toBeNull()
        expect(within(drawer).queryByRole('button', { name: /Decline/ })).toBeNull()
        await user.click(within(drawer).getByRole('button', { name: /Connect…/ }))
        expect(await within(drawer).findByRole('radio', { name: /General ledger/ })).toBeInTheDocument()
        expect(within(drawer).queryByRole('radio', { name: /CRM/ })).toBeNull()
        expect(within(drawer).queryByRole('radio', { name: /Connected another way/ })).toBeNull()
        expect(within(drawer).queryByRole('button', { name: /Add source/ })).toBeNull()
        await user.click(within(drawer).getByRole('radio', { name: /General ledger/ }))
        await user.click(within(drawer).getByRole('button', { name: /Mark connected/ }))
        expect(api.connect).toHaveBeenCalledWith('dr_dbt', { dataSourceId: 'ds_gl', note: undefined })
    })
})

describe('DataRequestsPanel — the platform team', () => {
    async function openReview(title = 'Finance marts', reviewer = 'usr_olga') {
        const user = userEvent.setup()
        as(['system:workspaces:create', 'system:org-admin'], [], reviewer)
        wrap(<DataRequestsPanel />)
        await user.click(await screen.findByRole('button', { name: `Review ${title}` }))
        return { user, drawer: screen.getByRole('dialog', { name: title }) }
    }

    it('lists what waits, for which workspace and how urgently', async () => {
        as(['system:workspaces:create'], [])
        wrap(<DataRequestsPanel />)
        const marts = (await screen.findByText('Finance marts')).closest('li')!
        expect(within(marts).getByText(/For Finance · from Ada Okafor/)).toBeInTheDocument()
        expect(within(marts).getByText('This week')).toBeInTheDocument()
        expect(within(marts).getByText('Waiting 3 days')).toBeInTheDocument()
        expect(within(screen.getByText('dbt core').closest('li')!).getByText(/Olga is on it/)).toBeInTheDocument()
    })

    it('starts one, assigning it to the reviewer', async () => {
        const { user, drawer } = await openReview()
        expect(within(drawer).getByText('FIN_DB.MARTS')).toBeInTheDocument()
        expect(within(drawer).getByText('Ben Hall')).toBeInTheDocument()
        await user.click(within(drawer).getByRole('button', { name: /Start — assign me/ }))
        expect(api.start).toHaveBeenCalledWith('dr_marts')
        expect(await within(drawer).findByText(/Sam Reader is on it/)).toBeInTheDocument()
        expect(within(drawer).queryByRole('button', { name: /Start — assign me/ })).toBeNull()
    })

    it('connects one to a source of that workspace, or one added from here', async () => {
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Connect…/ }))
        const mark = within(drawer).getByRole('button', { name: /Mark connected/ })
        expect(mark).toBeDisabled()                                                     // say which first
        await user.click(await within(drawer).findByRole('radio', { name: /General ledger/ }))
        expect(mark).toBeEnabled()

        // Add source from here: the source it adds is the one picked.
        ws.get.mockResolvedValue({ id: 'ws_fin', name: 'Finance', dataSources: [
            { id: 'ds_gl', label: 'General ledger', graphName: 'gl' }, { id: 'ds_ledger', label: 'Ledger', graphName: 'ledger' },
        ] })
        await user.click(within(drawer).getByRole('button', { name: /Add source to Finance/ }))
        await user.click(screen.getByRole('button', { name: 'add Ledger' }))
        const back = screen.getByRole('dialog', { name: 'Finance marts' })
        expect(await within(back).findByRole('radio', { name: /Ledger/, checked: true })).toBeInTheDocument()
        await user.type(within(back).getByRole('textbox'), 'All in')
        await user.click(within(back).getByRole('button', { name: /Mark connected/ }))
        expect(api.connect).toHaveBeenCalledWith('dr_marts', { dataSourceId: 'ds_ledger', note: 'All in' })
        expect(await within(back).findByRole('heading', { name: '“Finance marts” is connected' })).toBeInTheDocument()
    })

    it('marks one connected another way, naming no source', async () => {
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Connect…/ }))
        await user.click(within(drawer).getByRole('radio', { name: /Connected another way/ }))
        await user.click(within(drawer).getByRole('button', { name: /Mark connected/ }))
        expect(api.connect).toHaveBeenCalledWith('dr_marts', { dataSourceId: null, note: undefined })
    })

    it('answers nothing on their own request', async () => {
        const { drawer } = await openReview('Finance marts', 'usr_me')
        expect(within(drawer).getByText(/You asked for this, so someone else takes it on/)).toBeInTheDocument()
        for (const name of [/Connect…/, /Start — assign me/, /Decline/]) expect(within(drawer).queryByRole('button', { name })).toBeNull()
    })

    it('says plainly when the server refuses because they asked for it', async () => {
        useNotificationStore.setState({ notifications: [] })
        api.start.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403, detail: { type: 'own_request', message: 'x' } }))
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Start — assign me/ }))
        await waitFor(() => expect(useNotificationStore.getState().notifications.map(n => n.message))
            .toContain('You asked for this data, so someone else has to take it on — a workspace admin, the platform team, or an Owner or Steward of the source it becomes.'))
    })

    it('declines one with a reason', async () => {
        const { user, drawer } = await openReview()
        await user.click(within(drawer).getByRole('button', { name: /Decline/ }))
        await user.type(within(drawer).getByRole('textbox'), 'Finance Data has it')
        await user.click(within(drawer).getByRole('button', { name: /^Decline$/ }))
        expect(api.decline).toHaveBeenCalledWith('dr_marts', 'Finance Data has it')
    })
})

describe('with the switch off, or for someone it isn’t for', () => {
    it('shows nothing while data requests are off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, dataRequestsEnabled: false } })
        as(['system:workspaces:create'], ['workspace:datasource:read', 'workspace:datasource:manage'])
        const { container } = wrap(<>
            <WorkspaceDataRequestsPanel workspaceId="ws_fin" />
            <DataRequestsPanel />
            <AskForDataButton workspace={{ id: 'ws_fin', name: 'Finance' }} />
            <AskForDataPrompt workspace={{ id: 'ws_fin', name: 'Finance' }} />
        </>)
        await new Promise(r => setTimeout(r, 0))
        expect(container).toBeEmptyDOMElement()
        expect(api.listForWorkspace).not.toHaveBeenCalled()
        expect(api.listToAnswer).not.toHaveBeenCalled()
    })

    it('offers Ask for data to the workspace’s readers, never in the Playground, and the queue only to the platform team', async () => {
        wrap(<>
            <AskForDataButton workspace={{ id: 'ws_fin', name: 'Finance' }} primary />
            <AskForDataButton workspace={{ id: 'ws_play', name: 'Playground', kind: 'playground' }} />
            <AskForDataButton workspace={{ id: 'ws_other', name: 'Other' }} />
            <DataRequestsPanel />
        </>)
        expect(screen.getAllByRole('button', { name: /Ask for data/ })).toHaveLength(1)
        expect(screen.queryByText('Requests for data')).toBeNull()
        expect(api.listToAnswer).not.toHaveBeenCalled()
    })
})
