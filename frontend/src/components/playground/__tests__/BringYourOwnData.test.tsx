/**
 * Bring your own data: the templates download; files dropped or picked are read in the browser —
 * a things CSV with quoted values, a connections CSV, or one JSON file; the preview counts what
 * will be made, by type; CSV columns are matched (and can be re-matched) with the rest kept as
 * properties; every row that would be refused is named, by file and line, before anything is
 * sent — and the server's own refusals land in the same list; Create makes the graph and opens its
 * Context View; quota, switch and size refusals are said in plain words.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { importOwnData, notify, loadWorkspaces, download } = vi.hoisted(() => ({
    importOwnData: vi.fn(),
    notify: vi.fn(),
    loadWorkspaces: vi.fn(),
    download: vi.fn(),
}))
vi.mock('@/services/playgroundService', () => ({ playgroundService: { importOwnData } }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/services/importExportApiService', () => ({ triggerBrowserDownload: download }))

import { BringYourOwnData } from '../BringYourOwnData'
import { EXAMPLE, TEMPLATE_FILES } from '../ownData'
import { useWorkspacesStore } from '@/store/workspaces'

const THINGS = [
    'key,type,name,description,owner',
    'orders,Table,"Orders, all of them","The ""raw"" orders",Data engineering',
    'daily,Table,Daily sales,,Analytics',
    'dash,Dashboard,Sales dashboard,,Finance',
].join('\n')
const CONNECTIONS = 'from,type,to\norders,FEEDS,daily\ndaily,FEEDS,dash\n'

const file = (name: string, body: string) => new File([body], name, { type: name.endsWith('.json') ? 'application/json' : 'text/csv' })

function ViewPage() {
    return <p>view {useParams().viewId}</p>
}

const onClose = vi.fn()
function renderDialog(props: { quotaLeft?: number } = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/workspaces/ws_play']}>
                <Routes>
                    <Route path="/workspaces/:wsId" element={<BringYourOwnData workspaceId="ws_play" onClose={onClose} {...props} />} />
                    <Route path="/views/:viewId" element={<ViewPage />} />
                </Routes>
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

const pick = (...files: File[]) => userEvent.upload(screen.getByLabelText('Choose files'), files)

beforeEach(() => {
    vi.clearAllMocks()
    loadWorkspaces.mockResolvedValue(undefined)
    useWorkspacesStore.setState({ loadWorkspaces })
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:template')
    globalThis.URL.revokeObjectURL = vi.fn()
})

describe('Bring your own data', () => {
    it('is a labelled dialog that Escape closes', async () => {
        renderDialog()
        expect(screen.getByRole('dialog', { name: 'Bring your own data' })).toBeInTheDocument()
        await userEvent.keyboard('{Escape}')
        expect(onClose).toHaveBeenCalled()
    })

    it('offers the templates — things, connections and a JSON example — as downloads', async () => {
        renderDialog()
        const templates = screen.getByRole('list', { name: 'Templates' })
        await userEvent.click(within(templates).getByRole('button', { name: /things\.csv/ }))
        expect(download).toHaveBeenCalledWith('blob:template', 'things.csv')
        const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
        expect(await blob.text()).toBe(TEMPLATE_FILES['things.csv'])
        await userEvent.click(within(templates).getByRole('button', { name: /connections\.csv/ }))
        await userEvent.click(within(templates).getByRole('button', { name: /example\.json/ }))
        expect(download).toHaveBeenLastCalledWith('blob:template', 'example.json')
    })

    it('reads two CSV files, tells them apart, previews by type and matches columns', async () => {
        renderDialog()
        await pick(file('my-things.csv', THINGS), file('links.csv', CONNECTIONS))

        const preview = await screen.findByRole('region', { name: 'Preview' })
        expect(preview).toHaveTextContent('3 things')
        expect(preview).toHaveTextContent('2 connections')
        expect(within(preview).getByRole('list', { name: 'Things by type' })).toHaveTextContent('Table2Dashboard1')
        expect(within(preview).getByRole('list', { name: 'Connections by type' })).toHaveTextContent('FEEDS2')

        expect(screen.getByLabelText('Key')).toHaveValue('key')
        expect(screen.getByLabelText('Type of thing')).toHaveValue('type')
        expect(screen.getByLabelText('From')).toHaveValue('from')
        expect(screen.getByText(/become properties/)).toHaveTextContent('owner')
        // The name comes from the file until the person types one.
        expect(screen.getByLabelText('Name')).toHaveValue('my things')
        expect(screen.getByRole('button', { name: 'Create graph' })).toBeEnabled()
    })

    it('names each row that would be refused, by file and line, and holds Create until it’s fixed', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS), file('connections.csv', `${CONNECTIONS}daily,FEEDS,nowhere\n`))
        const problems = await screen.findByRole('region', { name: 'Rows to fix' })
        expect(problems).toHaveTextContent('connections.csv, line 4')
        expect(problems).toHaveTextContent('No thing has the key “nowhere”')
        expect(screen.getByRole('button', { name: 'Create graph' })).toBeDisabled()
    })

    it('re-matches a column: matched to nothing, a column becomes a property', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS))
        await userEvent.selectOptions(screen.getByLabelText('Description'), '')
        expect(screen.getByText(/become properties/)).toHaveTextContent('description, owner')
        // Without a type column every row needs one.
        await userEvent.selectOptions(screen.getByLabelText('Type of thing'), '')
        expect(await screen.findByRole('region', { name: 'Rows to fix' })).toHaveTextContent('things.csv, line 2')
    })

    it('says what is wrong with a file it can’t read, and keeps the others', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS))
        await pick(file('broken.csv', 'from,type,to\n"never closed,FEEDS,b'))
        expect(await screen.findByRole('alert')).toHaveTextContent('broken.csv: A quoted value opened on line 2 never closes')
        expect(screen.getByRole('region', { name: 'Preview' })).toHaveTextContent('3 things')
    })

    it('makes the graph from a JSON file — its name and description come along — and opens its Context View', async () => {
        importOwnData.mockResolvedValue({ dataSourceId: 'ds_new', viewId: 'v_ctx', viewIds: { context: 'v_ctx', graph: 'v_graph' } })
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        expect(await screen.findByLabelText('Name')).toHaveValue(EXAMPLE.name)
        expect(screen.getByLabelText(/Description/, { selector: 'textarea' })).toHaveValue(EXAMPLE.description)
        await userEvent.click(screen.getByRole('button', { name: 'Create graph' }))

        expect(importOwnData).toHaveBeenCalledWith({
            name: EXAMPLE.name, description: EXAMPLE.description, things: EXAMPLE.things, connections: EXAMPLE.connections,
        })
        expect(await screen.findByText('view v_ctx')).toBeInTheDocument()
        expect(loadWorkspaces).toHaveBeenCalled()
        expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('Coffee shop sales'))
    })

    it('shows the server’s refused rows where its own are shown', async () => {
        importOwnData.mockRejectedValue(Object.assign(new Error('Some rows can’t be used'), {
            status: 422,
            detail: { type: 'invalid_rows', message: 'Some rows can’t be used', errors: [
                { section: 'things', index: 1, field: 'name', message: 'Name is reserved' },
            ] },
        }))
        renderDialog()
        await pick(file('things.csv', THINGS))
        await userEvent.click(screen.getByRole('button', { name: 'Create graph' }))
        const problems = await screen.findByRole('region', { name: 'Rows to fix' })
        expect(problems).toHaveTextContent('things.csv, line 3')
        expect(problems).toHaveTextContent('Name is reserved')
        expect(screen.queryByText(/^view /)).toBeNull()
    })

    it.each([
        [403, 'quota_reached', /used all your graphs/],
        [403, 'feature_disabled', /turned off/],
        [403, 'playground_not_member', /Join the Playground/],
        [413, 'too_large', /more than the Playground takes/],
    ])('says a %s %s in plain words', async (status, type, words) => {
        importOwnData.mockRejectedValue(Object.assign(new Error('raw'), { status, detail: { type, message: 'raw', limit: 5000 } }))
        renderDialog()
        await pick(file('things.csv', THINGS))
        await userEvent.click(screen.getByRole('button', { name: 'Create graph' }))
        expect(await screen.findByRole('alert')).toHaveTextContent(words)
    })

    it('says so up front, and makes nothing, once every graph is used', async () => {
        renderDialog({ quotaLeft: 0 })
        expect(screen.getByText(/used all your graphs/)).toBeInTheDocument()
        await pick(file('things.csv', THINGS))
        expect(screen.getByRole('button', { name: 'Create graph' })).toBeDisabled()
    })

    it('waits for its files before it can be created', () => {
        renderDialog()
        expect(screen.getByRole('button', { name: 'Create graph' })).toBeDisabled()
        expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull()
    })
})
