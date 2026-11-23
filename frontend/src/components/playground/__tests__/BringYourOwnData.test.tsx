/**
 * New data source from a file: the templates download — the simple ones always, the chosen data
 * model's standard one once there is one; files are read in the browser and previewed by type;
 * the data models on offer are cards with where each comes from, the best-fitting approved one
 * chosen — never one that fits nothing, and nothing without scores — and "Make one from my file"
 * last. Each of the file's types is matched to one of the model's, or its rows left out, and a
 * connection the model's relationship doesn't allow is named. It opens in its Context View, with a
 * Graph view and a Hierarchy if chosen — a Hierarchy only of a model that nests one type in
 * another. Create makes the graph (once), then
 * loads the file into it with the standard import; a load that fails is tried again into the same
 * graph. Done, it opens, or opens with the import for more data.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'

const svc = vi.hoisted(() => ({
    listModels: vi.fn(), matchModels: vi.fn(), createGraph: vi.fn(), addLayerTypes: vi.fn(),
    modelTemplateUrl: vi.fn((id: string, fmt: string) => `/api/v1/playground/models/${id}/template?format=${fmt}`),
    get: vi.fn(), suggest: vi.fn(), listDataSources: vi.fn(), loadWorkspaces: vi.fn(),
}))
vi.mock('@/services/playgroundService', () => ({
    playgroundService: {
        listModels: svc.listModels, matchModels: svc.matchModels, createGraph: svc.createGraph,
        addLayerTypes: svc.addLayerTypes, modelTemplateUrl: svc.modelTemplateUrl,
    },
}))
vi.mock('@/services/ontologyDefinitionService', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/services/ontologyDefinitionService')>()
    return { ...real, ontologyDefinitionService: { ...real.ontologyDefinitionService, get: svc.get, suggest: svc.suggest } }
})
vi.mock('@/services/workspaceService', async (importOriginal) => {
    const real = await importOriginal<typeof import('@/services/workspaceService')>()
    return { ...real, workspaceService: { ...real.workspaceService, listDataSources: svc.listDataSources } }
})
vi.mock('@/services/importExportApiService', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/services/importExportApiService')>(),
    importInParts: vi.fn(), getImport: vi.fn(), getImportPreview: vi.fn(), pollJob: vi.fn(), triggerBrowserDownload: vi.fn(),
}))
// layers-ui's own; here it only adds what it's given, as the server would, and says so.
vi.mock('../AddTypesToMyLayer', () => ({
    AddTypesToMyLayer: (p: { ontologyId: string; missing: { entityTypes: { name: string }[] }; onAdded: (r: unknown) => void }) => {
        const qc = useQueryClient()
        if (!p.missing.entityTypes.length) return null
        return (
            <button type="button" onClick={async () => {
                await qc.invalidateQueries({ queryKey: ['playground'] })
                p.onAdded({ ontologyId: 'ont_mine_v3', version: 3, movedGraphs: 1, relationshipTypeIds: {},
                    entityTypeIds: Object.fromEntries(p.missing.entityTypes.map(t => [t.name, t.name.toLowerCase()])) })
            }}>
                Add {p.missing.entityTypes.map(t => t.name).join(', ')} to {p.ontologyId}
            </button>
        )
    },
}))

import { getImportPreview, importInParts, pollJob, triggerBrowserDownload } from '@/services/importExportApiService'
import { BringYourOwnData } from '../BringYourOwnData'
import { EXAMPLE, TEMPLATE_FILES } from '../ownData'
import { useWorkspacesStore } from '@/store/workspaces'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

const THINGS = [
    'key,type,name,owner',
    'orders,Table,"Orders, all of them",Data',
    'daily,Table,Daily sales,',
    'dash,Dashboard,Sales dashboard,Finance',
    'weekly,Report,Weekly report,',
].join('\n')
const CONNECTIONS = 'from,type,to\norders,FEEDS,daily\ndaily,FEEDS,dash\ndaily,FEEDS,weekly\n'

const model = (id: string, name: string, kind: string, extra = {}) => ({
    id, name, kind, description: null, version: 1, isPublished: true, entityTypeCount: 3, relationshipTypeCount: 1, usedBy: 0, ...extra,
})
const MODELS = [
    model('ont_pipes', 'Data pipelines', 'approved'),
    model('ont_fin', 'Finance reporting', 'approved'),
    model('ont_mine', 'My shop model', 'yours'),
    model('bp_retail', 'Retail sample', 'sample'),
    model('ont_draft', 'Half done', 'yours', { isPublished: false }),
]
const layer = (id: string, entities: Record<string, string>, rels: Record<string, [string, string[], string[]]>) => ({
    id, name: id, version: 1, isPublished: true,
    entityTypeDefinitions: Object.fromEntries(Object.entries(entities).map(([k, name]) => [k, { name }])),
    relationshipTypeDefinitions: Object.fromEntries(Object.entries(rels).map(([k, [name, source_types, target_types]]) => [k, { name, source_types, target_types }])),
})
const LAYERS: Record<string, unknown> = {
    ont_pipes: layer('ont_pipes', { table: 'Table', dashboard: 'Dashboard', system: 'System' }, { FEEDS: ['Feeds', ['table'], ['table', 'dashboard']] }),
    ont_mine: layer('ont_mine', { table: 'Table', dashboard: 'Dashboard' }, { FEEDS: ['Feeds', [], []] }),
    ont_mine_v3: layer('ont_mine_v3', { table: 'Table', dashboard: 'Dashboard', report: 'Report' }, { FEEDS: ['Feeds', [], []] }),
    own_1: layer('own_1', { salesTable: 'Sales table', dashboard: 'Dashboard', report: 'Report' }, { FLOWS_INTO: ['flows into', [], []] }),
}
const score = (ontologyId: string, jaccardScore: number) => ({
    ontologyId, ontologyName: ontologyId, version: 1, jaccardScore, coveredEntityTypes: jaccardScore ? ['Table'] : [],
    uncoveredEntityTypes: ['Report'], coveredRelationshipTypes: [], uncoveredRelationshipTypes: [], totalEntityTypes: 2, totalRelationshipTypes: 0,
})
const scores = (...matches: ReturnType<typeof score>[]) => ({ suggested: {}, matchingOntologies: matches, mergedVariants: {} })
const MADE = { dataSourceId: 'ds_new', graphId: 'g_new', mainBranchId: 'br_main', viewId: 'v_ctx', viewIds: { context: 'v_ctx', graph: 'v_graph' } }
const completed = (extra = {}) => ({ jobId: 'j1', jobType: 'ingest', graphId: 'g_new', status: 'completed', branchId: 'br_import',
    summary: { new: 7, updated: 0, unchanged: 0, deleted: 0, invalid: 0, publish: { state: 'queued' } }, ...extra }) as unknown as Job

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
const create = () => screen.getByRole('button', { name: 'Create' })
const card = (name: string | RegExp) => screen.getByRole('button', { name })
/** The rows the import was sent, as objects. */
async function sentRows(call = 0) {
    const sent = vi.mocked(importInParts).mock.calls[call][2]
    return (await sent.text()).trim().split('\n').map(l => JSON.parse(l))
}

beforeEach(() => {
    vi.clearAllMocks()
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, playgroundEnabled: true } })
    svc.loadWorkspaces.mockResolvedValue(undefined)
    useWorkspacesStore.setState({ loadWorkspaces: svc.loadWorkspaces })
    svc.listModels.mockResolvedValue(MODELS)
    svc.matchModels.mockResolvedValue(scores(score('ont_mine', 0.9), score('ont_pipes', 0.6), score('ont_fin', 0.1)))
    svc.get.mockImplementation(async (id: string) => LAYERS[id])
    svc.createGraph.mockResolvedValue(MADE)
    svc.listDataSources.mockResolvedValue([{ id: 'ds_new', ontologyId: 'own_1' }])
    vi.mocked(importInParts).mockResolvedValue({ jobId: 'j1', branchId: 'br_import', sourceUri: 's', status: 'pending' })
    vi.mocked(pollJob).mockResolvedValue(completed())
    vi.mocked(getImportPreview).mockResolvedValue({ sample: [] } as never)
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:template')
    globalThis.URL.revokeObjectURL = vi.fn()
})

describe('New data source from a file', () => {
    it('is a labelled dialog that Escape closes', async () => {
        renderDialog()
        expect(screen.getByRole('dialog', { name: 'New data source from a file' })).toBeInTheDocument()
        await userEvent.keyboard('{Escape}')
        expect(onClose).toHaveBeenCalled()
    })

    it('offers the simple templates always, and the chosen data model’s standard template', async () => {
        renderDialog()
        const templates = screen.getByRole('list', { name: 'Templates' })
        await userEvent.click(within(templates).getByRole('button', { name: /things\.csv/ }))
        expect(triggerBrowserDownload).toHaveBeenCalledWith('blob:template', 'things.csv')
        expect(await (vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).text()).toBe(TEMPLATE_FILES['things.csv'])
        expect(screen.queryByText(/The standard template for/)).toBeNull()

        await userEvent.click(await screen.findByRole('button', { name: /Finance reporting/ }))
        await userEvent.click(screen.getByRole('button', { name: 'Excel' }))
        expect(svc.modelTemplateUrl).toHaveBeenCalledWith('ont_fin', 'xlsx')
        expect(triggerBrowserDownload).toHaveBeenLastCalledWith('/api/v1/playground/models/ont_fin/template?format=xlsx', 'finance-reporting-template.xlsx')
    })

    it('reads two CSV files and previews what they make, by type', async () => {
        renderDialog()
        await pick(file('my-things.csv', THINGS), file('links.csv', CONNECTIONS))
        const preview = await screen.findByRole('region', { name: 'Preview' })
        expect(preview).toHaveTextContent('4 things')
        expect(preview).toHaveTextContent('3 connections')
        expect(within(preview).getByRole('list', { name: 'Things by type' })).toHaveTextContent('Table2Dashboard1Report1')
        expect(screen.getByLabelText('Name')).toHaveValue('my things')
    })

    it('lists the published data models with where each comes from, and making one from the file last', async () => {
        renderDialog()
        const models = await screen.findByRole('region', { name: 'Data model' })
        await within(models).findByText('Data pipelines')
        await userEvent.click(within(models).getByRole('button', { name: /Show all 4/ }))
        const cards = within(models).getAllByRole('button').filter(b => b.textContent?.match(/pipelines|Finance|shop|sample|from my file/i))
        expect(cards.at(-1)).toHaveTextContent('Make one from my file')
        expect(cards.at(-1)).toHaveTextContent('A data model just for this graph, used only in the Playground')
        expect(card(/Data pipelines/)).toHaveTextContent('Approved')
        expect(card(/My shop model/)).toHaveTextContent('Yours')
        expect(card(/Retail sample/)).toHaveTextContent('Sample')
        expect(within(models).queryByText('Half done')).toBeNull()       // a draft: no graph is made on one
    })

    it('chooses the best-fitting approved data model — not a better one of another kind — scored by the Playground', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS), file('links.csv', CONNECTIONS))
        await waitFor(() => expect(card(/Data pipelines/)).toHaveClass('border-blue-500'))
        expect(card(/Data pipelines/)).toHaveTextContent('BEST FIT')
        expect(card(/My shop model/)).not.toHaveClass('border-blue-500')
        expect(svc.matchModels).toHaveBeenCalledWith(expect.objectContaining({ totalNodes: 4, totalEdges: 3 }), 0)
        expect(svc.suggest).not.toHaveBeenCalled()
    })

    it('never chooses one that fits nothing', async () => {
        svc.matchModels.mockResolvedValue(scores(score('ont_mine', 0.4), score('ont_pipes', 0), score('ont_fin', 0)))
        renderDialog()
        await pick(file('things.csv', THINGS))
        await screen.findByText(/Make one from my file/)
        await waitFor(() => expect(svc.matchModels).toHaveBeenCalled())
        await screen.findByText(/Doesn't cover/)
        for (const name of [/Data pipelines/, /Finance reporting/, /My shop model/]) expect(card(name)).not.toHaveClass('border-blue-500')
        expect(screen.queryByText('BEST FIT')).toBeNull()
        expect(create()).toBeDisabled()
    })

    it('without scores — refused, say — shows plain cards and chooses nothing', async () => {
        svc.matchModels.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }))
        renderDialog()
        await pick(file('things.csv', THINGS))
        await waitFor(() => expect(svc.matchModels).toHaveBeenCalled())
        await waitFor(() => expect(screen.queryByText(/Matching your file/)).toBeNull())
        expect(card(/Data pipelines/)).toHaveTextContent('3 entity types · 1 relationships')
        for (const name of [/Data pipelines/, /Finance reporting/, /My shop model/]) expect(card(name)).not.toHaveClass('border-blue-500')
        expect(screen.queryByText('BEST FIT')).toBeNull()
    })

    it('matches the file’s types by id or name, and holds Create until each is matched or left out', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS), file('links.csv', CONNECTIONS))
        const table = await screen.findByRole('table', { name: 'Match types' })
        expect(within(table).getByLabelText('Match Table')).toHaveValue('table')
        expect(within(table).getByLabelText('Match Dashboard')).toHaveValue('dashboard')
        expect(within(table).getByLabelText('Match FEEDS')).toHaveValue('FEEDS')
        expect(within(table).getByLabelText('Match Report')).toHaveValue('__choose__')
        expect(create()).toBeDisabled()

        await userEvent.selectOptions(within(table).getByLabelText('Match Report'), 'Leave these rows out')
        expect(create()).toBeEnabled()
    })

    it('names connections the chosen relationship doesn’t join', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS), file('links.csv', CONNECTIONS))
        const table = await screen.findByRole('table', { name: 'Match types' })
        await userEvent.selectOptions(within(table).getByLabelText('Match Report'), 'System')
        expect(table).toHaveTextContent('Feeds doesn’t join Table → System in this data model')
    })

    it('makes the graph on the chosen data model, then loads the file — without the rows left out — and publishes it', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS), file('links.csv', CONNECTIONS))
        const table = await screen.findByRole('table', { name: 'Match types' })
        await userEvent.selectOptions(within(table).getByLabelText('Match Report'), 'Leave these rows out')
        await userEvent.click(create())

        expect(svc.createGraph).toHaveBeenCalledWith({ name: 'things', model: { ontologyId: 'ont_pipes' }, types: ['table', 'dashboard'] })
        expect(await screen.findByRole('region', { name: 'Done' })).toHaveTextContent('“things” is ready')
        expect(vi.mocked(importInParts).mock.calls[0].slice(0, 2)).toEqual(['ws_play', 'g_new'])
        expect(vi.mocked(importInParts).mock.calls[0][3]).toMatchObject({ format: 'ndjson', autoPublish: true })
        expect(vi.mocked(importInParts).mock.calls[0][3]?.branchId).toBeUndefined()
        const rows = await sentRows()
        expect(rows.filter(r => r.kind === 'node').map(r => [r.urn, r.entityType])).toEqual([
            ['urn:playground:orders', 'table'], ['urn:playground:daily', 'table'], ['urn:playground:dash', 'dashboard']])
        expect(rows.filter(r => r.kind === 'edge').map(r => r.targetUrn)).toEqual(['urn:playground:daily', 'urn:playground:dash'])
        expect(svc.loadWorkspaces).toHaveBeenCalled()
    })

    it('settles what identifies each thing first, and loads the things by it', async () => {
        renderDialog()
        await pick(file('things.csv', 'code,type,name\nA,Table,Alpha\nB,Table,Beta\n'))
        const step = await screen.findByRole('region', { name: 'Identifier' })
        const column = within(step).getByLabelText('Read from the column')
        expect(column).toHaveValue('')                               // no name says which
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        expect(create()).toBeDisabled()

        await userEvent.selectOptions(column, 'code')
        expect(within(step).getByRole('list', { name: 'First identifiers' })).toHaveTextContent('AB')
        expect(create()).toBeEnabled()
        await userEvent.click(create())
        await screen.findByRole('region', { name: 'Done' })
        expect((await sentRows()).map(r => r.urn)).toEqual(['urn:playground:A', 'urn:playground:B'])
    })

    it('opens in its Context View alone unless other canvases are chosen, and sends those chosen', async () => {
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        const canvases = screen.getByRole('region', { name: 'Canvases' })
        expect(within(canvases).getByRole('checkbox', { name: 'Context View, opens first' })).toHaveAttribute('aria-checked', 'true')
        await userEvent.click(within(canvases).getByRole('checkbox', { name: /^Graph/ }))
        await userEvent.click(create())
        expect(svc.createGraph).toHaveBeenCalledWith(expect.objectContaining({ views: ['graph'] }))
    })

    it('offers a Hierarchy only of a data model that nests one type in another, saying why not otherwise', async () => {
        svc.get.mockImplementation(async (id: string) => id === 'ont_pipes' ? {
            ...(LAYERS.ont_pipes as object),
            relationshipTypeDefinitions: { FEEDS: { name: 'Feeds', source_types: ['table'], target_types: ['dashboard'] },
                HAS: { name: 'Has', is_containment: true, source_types: ['dashboard'], target_types: ['table'] } },
        } : LAYERS[id])
        renderDialog()
        await pick(file('things.csv', THINGS), file('links.csv', CONNECTIONS))
        const canvases = screen.getByRole('region', { name: 'Canvases' })
        const tree = () => within(canvases).getByRole('checkbox', { name: /^Hierarchy/ })
        await waitFor(() => expect(tree()).not.toHaveAttribute('aria-disabled'))
        expect(tree()).toHaveTextContent('Dashboards and their tables')

        // A data model with nothing nested — or one made from the file — can't have one, and says so.
        await userEvent.click(card(/Finance reporting/))
        await waitFor(() => expect(tree()).toHaveAttribute('aria-disabled', 'true'))
        await userEvent.click(screen.getByRole('button', { name: /Make one from my file/ }))
        expect(tree()).toHaveAccessibleDescription(/doesn’t put one inside another/)
        await userEvent.click(tree())
        await userEvent.click(create())
        expect(svc.createGraph.mock.calls[0][0]).not.toHaveProperty('views')
    })

    it('says which views it was made with — and a Hierarchy asked for that it couldn’t have', async () => {
        svc.createGraph.mockResolvedValueOnce({ ...MADE, viewIds: { context: 'v_ctx', graph: 'v_graph', hierarchy: null } })
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        await userEvent.click(create())
        const done = await screen.findByRole('region', { name: 'Done' })
        expect(done).toHaveTextContent('It opens in its Context View, with a Graph view beside it.')
        expect(done).toHaveTextContent('It has no Hierarchy view: its data model has nothing that holds anything else.')
    })

    it('done, opens the graph, or opens it with the import for more data', async () => {
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        await userEvent.click(create())
        const done = await screen.findByRole('region', { name: 'Done' })
        expect(done).toHaveTextContent('It’s being published')
        expect(done).toHaveTextContent('7 added')
        expect(screen.getByRole('link', { name: 'Add more data' })).toHaveAttribute('href', '/views/v_ctx?import=1')
        await userEvent.click(screen.getByRole('link', { name: 'Open it' }))
        expect(await screen.findByText('view v_ctx')).toBeInTheDocument()
    })

    it('makes a data model from the file, its types read back so the rows name them by id', async () => {
        const things = 'key,type,name\na,Sales table,A\nb,Dashboard,B\n'
        renderDialog()
        await pick(file('things.csv', things), file('links.csv', 'from,type,to\na,flows into,b\n'))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        expect(screen.queryByRole('table', { name: 'Match types' })).toBeNull()
        await userEvent.click(create())

        await screen.findByRole('region', { name: 'Done' })
        expect(svc.createGraph).toHaveBeenCalledWith({
            name: 'things',
            model: { infer: { thingTypes: ['Sales table', 'Dashboard'], connectionTypes: [{ name: 'flows into', ends: [['Sales table', 'Dashboard']] }] } },
        })
        expect(svc.listDataSources).toHaveBeenCalledWith('ws_play')
        expect(svc.get).toHaveBeenCalledWith('own_1')
        expect((await sentRows()).map(r => r.entityType ?? r.edgeType)).toEqual(['salesTable', 'dashboard', 'FLOWS_INTO'])
    })

    it('names the file’s types by the ids the server says they got, with no read-back', async () => {
        svc.createGraph.mockResolvedValueOnce({
            dataSourceId: 'ds_new', graphId: 'g_new', mainBranchId: 'br_main', viewId: 'v_ctx',
            viewIds: { context: 'v_ctx', graph: 'v_graph' }, ontologyId: 'own_1',
            typeIds: { entity: { 'Sales table': 'salesTable', Dashboard: 'dashboard' },
                       relationship: { 'flows into': 'FLOWS_INTO' } },
        })
        renderDialog()
        await pick(file('things.csv', 'key,type,name\na,Sales table,A\nb,Dashboard,B\n'),
                   file('links.csv', 'from,type,to\na,flows into,b\n'))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        await userEvent.click(create())

        await screen.findByRole('region', { name: 'Done' })
        expect(svc.listDataSources).not.toHaveBeenCalled()
        expect((await sentRows()).map(r => r.entityType ?? r.edgeType)).toEqual(['salesTable', 'dashboard', 'FLOWS_INTO'])
    })

    it('tries a failed load again into the same graph, never making it twice', async () => {
        vi.mocked(pollJob)
            .mockResolvedValueOnce({ jobId: 'j1', jobType: 'ingest', graphId: 'g_new', status: 'failed',
                errorMessage: 'too_many_rows: more than 200,000 rows', summary: { failure: { code: 'too_many_rows', limit: 200000 } } } as unknown as Job)
            .mockResolvedValueOnce(completed())
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        await userEvent.click(create())

        const failed = await screen.findByRole('region', { name: 'Load failed' })
        expect(failed).toHaveTextContent('was made, but your file didn’t load')
        expect(failed).toHaveTextContent('This file has more rows than an import here may carry (200,000).')
        await userEvent.click(screen.getByRole('button', { name: /Try the import again/ }))
        expect(await screen.findByRole('region', { name: 'Done' })).toBeInTheDocument()
        expect(svc.createGraph).toHaveBeenCalledTimes(1)
        expect(importInParts).toHaveBeenCalledTimes(2)
        expect(vi.mocked(importInParts).mock.calls[1][1]).toBe('g_new')
    })

    it('keeps the first load in a draft when asked, and matches by a property', async () => {
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        await userEvent.click(screen.getByRole('button', { name: /More options/ }))
        await userEvent.click(screen.getByRole('checkbox', { name: /Keep the first load in a draft/ }))
        await userEvent.click(screen.getByRole('radio', { name: /A property/ }))
        expect(create()).toBeDisabled()                                       // the property must be named
        await userEvent.type(screen.getByLabelText('Property name'), 'external_id')
        await userEvent.click(create())
        expect(await screen.findByRole('region', { name: 'Done' })).toHaveTextContent('It’s in a draft')
        expect(vi.mocked(importInParts).mock.calls[0][3]).toMatchObject({ autoPublish: false, identifier: 'prop.external_id' })
    })

    it('on the reader’s own data model, adds the types it lacks and matches them', async () => {
        svc.listModels.mockResolvedValueOnce(MODELS).mockResolvedValue([...MODELS.filter(m => m.id !== 'ont_mine'),
            model('ont_mine_v3', 'My shop model', 'yours', { version: 3 })])
        renderDialog()
        await pick(file('things.csv', THINGS), file('links.csv', CONNECTIONS))
        await userEvent.click(await screen.findByRole('button', { name: /My shop model/ }))
        await userEvent.click(await screen.findByRole('button', { name: 'Add Report to ont_mine' }))

        const table = await screen.findByRole('table', { name: 'Match types' })
        await waitFor(() => expect(within(table).getByLabelText('Match Report')).toHaveValue('report'))
        await userEvent.click(create())
        expect(svc.createGraph).toHaveBeenCalledWith(expect.objectContaining({ model: { ontologyId: 'ont_mine_v3' } }))
    })

    it('holds Create on rows that would be refused, naming them by file and line', async () => {
        renderDialog()
        await pick(file('things.csv', THINGS), file('connections.csv', `${CONNECTIONS}daily,FEEDS,nowhere\n`))
        const problems = await screen.findByRole('region', { name: 'Rows to fix' })
        expect(problems).toHaveTextContent('connections.csv, line 5')
        expect(problems).toHaveTextContent('No thing has the key “nowhere”')
        expect(create()).toBeDisabled()
    })

    it('brings a JSON file’s own name and description along', async () => {
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        expect(await screen.findByLabelText('Name')).toHaveValue(EXAMPLE.name)
        expect(screen.getByLabelText(/Description/, { selector: 'textarea' })).toHaveValue(EXAMPLE.description)
    })

    it.each([
        [409, 'playground_quota', /used all your graphs/],
        [409, 'layer_quota', /as many data models of your own/],
        [403, 'feature_disabled', /turned off/],
        [403, 'playground_not_member', /Join the Playground/],
        [413, 'too_large', /more types than a data model made from a file may have \(up to 50 of each\)/],
    ])('says a %s %s in plain words, and makes nothing', async (status, type, words) => {
        svc.createGraph.mockRejectedValue(Object.assign(new Error('raw'), { status, detail: { type, message: 'raw', limit: 50 } }))
        renderDialog()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        await userEvent.click(create())
        expect(await screen.findByRole('alert')).toHaveTextContent(words)
        expect(importInParts).not.toHaveBeenCalled()
    })

    it('says so up front, and makes nothing, once every graph is used', async () => {
        renderDialog({ quotaLeft: 0 })
        expect(screen.getByText(/used all your graphs/)).toBeInTheDocument()
        await pick(file('example.json', TEMPLATE_FILES['example.json']))
        await userEvent.click(await screen.findByRole('button', { name: /Make one from my file/ }))
        expect(create()).toBeDisabled()
    })

    it('waits for its files before it can be created', () => {
        renderDialog()
        expect(create()).toBeDisabled()
        expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull()
    })
})
