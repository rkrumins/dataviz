/**
 * The fleet inventory, moved from Admin → Infrastructure to Admin → Versioned graphs (these are
 * `VersionedGraphsPanel.test.tsx`'s 22 inventory tests, ported). It names each graph and its copy,
 * marks forks, orphans and platform copies, pages by cursor, filters on the server, and from each
 * row's menu rebuilds a graph's copy, checks it against the database, opens its data source, moves
 * a fork to the trash, moves a platform copy, loads an unloaded graph and adopts a connected
 * graph's copy; "Settings…" opens the graph's settings. Each row says the read mode in force, where
 * it was chosen, and the one chosen when it can't be had, with the server's why; the table's
 * semantics hold (every row's parts are cells, its footer outside it).
 */
import { useState } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import type { GraphProvider, VersionedGraphRow } from '@/services/systemStatusService'
import type { GraphInventoryFilter } from '@/services/settingsService'
import { row as fixtureRow } from '../__fixtures__/api'
import { allowMenus, json, mockApi, renderWithApi, type Sent } from './helpers'

vi.mock('@tanstack/react-virtual', async () => (await import('./helpers')).virtualizerMock())

const { moveProjection, rebuildProjection, reconcileProjection, deleteFork, loadGraph, adoptGraph } = vi.hoisted(() => ({
    moveProjection: vi.fn(),
    rebuildProjection: vi.fn(),
    reconcileProjection: vi.fn(),
    deleteFork: vi.fn(),
    loadGraph: vi.fn(),
    adoptGraph: vi.fn(),
}))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return { ...actual, systemStatusService: { ...actual.systemStatusService, moveProjection, loadGraph, adoptGraph } }
})
vi.mock('@/services/versioningApiService', () => ({ rebuildProjection, reconcileProjection, deleteFork }))

import { GraphInventory } from '../GraphInventory'

const READS = CATALOGUE.settings.find((s) => s.key === 'reads.mode')!
const CLASSES = CATALOGUE.settings.find((s) => s.key === 'residency.class')!
const short = (id: string) => READS.choices.find((c) => c.id === id)!.short
const classTitle = (id: string) => CLASSES.choices.find((c) => c.id === id)!.title

const PROVIDERS: GraphProvider[] = [
    { id: 'falkor-eu', name: 'EU graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true },
]

const row = (over: Partial<VersionedGraphRow>) => fixtureRow({ workspaceId: 'ws1', workspaceName: 'Sales', readModeEffective: 'in_place', ...over })
const MAIN = row({})
const FORK = row({
    graphId: 'graph_b', dataSourceId: 'dsfork_1', dataSourceLabel: null, falkorGraphName: 'gv_fork_b',
    owned: true, forkParentGraphId: 'graph_a', lag: 2, committed: 5, projected: 3, residency: null, residencyState: null, readModeEffective: null,
})
const ORPHAN = row({
    graphId: 'graph_c', dataSourceId: 'ds_gone', dataSourceLabel: null, workspaceName: null,
    falkorGraphName: 'old_key', orphan: true, lastError: 'connection refused',
})
const PLATFORM = row({
    graphId: 'graph_d', dataSourceId: 'ds4', dataSourceLabel: 'Orders', owned: true,
    falkorGraphName: 'gvp_graph_d{aph_d.1}', residency: 'coldline', residencyState: 'evicted', evictedReason: 'idle_coldline', status: 'evicted',
})

/** The list endpoint answers `pages` in turn (the last one again after that). */
function serve(...pages: Array<{ graphs: VersionedGraphRow[]; nextCursor: string | null; total?: number }>): Sent[] {
    let n = 0
    return mockApi('ok', (req) => (req.path.endsWith('/admin/versioning/graphs') ? json(pages[Math.min(n++, pages.length - 1)]) : undefined))
}
const listCalls = (sent: Sent[]) => sent.filter((r) => r.path.endsWith('/admin/versioning/graphs'))

function Inventory({ onOpenSettings = () => {} }: { onOpenSettings?: (row: VersionedGraphRow) => void }) {
    const [filter, setFilter] = useState<GraphInventoryFilter>({})
    return <GraphInventory filter={filter} onFilter={setFilter} onOpenSettings={onOpenSettings} providers={PROVIDERS} />
}

const rowOf = (label: string) => within(screen.getByText(label).closest('[role="row"]') as HTMLElement)

/** Opens a row's menu and returns the item named `name`. */
async function menuItem(rowLabel: string, name: string | RegExp) {
    await userEvent.click(screen.getByRole('button', { name: `More actions for ${rowLabel}` }))
    return screen.findByRole('menuitem', { name })
}

beforeAll(allowMenus)
beforeEach(() => {
    for (const fn of [moveProjection, rebuildProjection, reconcileProjection, deleteFork, loadGraph, adoptGraph]) fn.mockReset()
})

describe('GraphInventory', () => {
    it("says what each graph's readers get while a new version lands, and opens its settings from its row", async () => {
        const own = row({ graphId: 'graph_e', dataSourceId: 'ds5', dataSourceLabel: 'Payments', owned: true, readMode: 'latest', readModeEffective: 'latest',
            readModeSource: 'graph' })
        serve({ graphs: [MAIN, own, FORK], nextCursor: null })
        const onOpenSettings = vi.fn()
        renderWithApi(<Inventory onOpenSettings={onOpenSettings} />)

        await screen.findByText('Customer 360')
        expect(rowOf('Customer 360').getByText(`Reads: ${short('in_place')}`)).toBeInTheDocument()
        expect(rowOf('Customer 360').queryByText(/^set /)).not.toBeInTheDocument()     // the platform's, as every graph's
        expect(rowOf('Payments').getByText(`Reads: ${short('latest')}`)).toBeInTheDocument()
        expect(rowOf('Payments').getByText('set on this graph')).toBeInTheDocument()
        expect(rowOf('Customer 360').getByText(`Class: ${classTitle('standard')}`)).toBeInTheDocument()
        expect(rowOf('dsfork_1').queryByText(/^Reads:/)).not.toBeInTheDocument()   // a fork follows its root
        expect(rowOf('dsfork_1').getByText('Follows the graph it was forked from')).toBeInTheDocument()

        // One name per graph, and the visible words in it.
        await userEvent.click(rowOf('Payments').getByRole('button', { name: 'Settings… for Payments' }))
        expect(onOpenSettings).toHaveBeenCalledWith(own)
    })

    it('shows the mode in force when the one chosen can’t be had: which was chosen, why, and where', async () => {
        const why = CATALOGUE.why.builds_off
        const held = row({ graphId: 'graph_h', dataSourceId: 'ds_h', dataSourceLabel: 'Sales lineage', owned: true, readMode: 'beside',
            readModeEffective: 'in_place', readModeDeclared: 'beside', readModeSource: 'graph', readModeWhy: [{ code: 'builds_off', text: why.text, fix: why.fix }] })
        const viaWorkspace = row({ graphId: 'graph_w', dataSourceId: 'ds_w', dataSourceLabel: 'Billing', owned: false, readMode: null,
            readModeEffective: 'in_place', readModeDeclared: 'beside', readModeSource: 'workspace',
            readModeWhy: [{ code: 'connected_graph', text: CATALOGUE.why.connected_graph.text, fix: null }] })
        serve({ graphs: [held, viaWorkspace], nextCursor: null })
        renderWithApi(<Inventory />)

        const sales = within((await screen.findByText('Sales lineage')).closest('[role="row"]') as HTMLElement)
        expect(sales.getByText(`Reads: ${short('in_place')}`)).toBeInTheDocument()       // in force, never the choice
        expect(sales.getByText(`Chose ${short('beside')}`)).toBeInTheDocument()
        expect(sales.getByText(why.text)).toBeInTheDocument()
        expect(sales.getByText('set on this graph')).toBeInTheDocument()
        expect(rowOf('Billing').getByText(`Chose ${short('beside')}`)).toBeInTheDocument()
        expect(rowOf('Billing').getByText('set for its workspace')).toBeInTheDocument()
        expect(rowOf('Billing').getByText(CATALOGUE.why.connected_graph.text)).toBeInTheDocument()
    })

    it('keeps the table’s semantics: every part of a row a cell, a header for each, the footer outside it', async () => {
        serve({ graphs: [MAIN, FORK], nextCursor: 'graph_b' })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')
        const table = screen.getByRole('table', { name: 'Versioned graphs' })
        for (const r of within(table).getAllByRole('row')) {
            for (const child of r.children) expect(['cell', 'columnheader']).toContain(child.getAttribute('role'))
        }
        const headers = within(table).getAllByRole('columnheader')
        expect(within(table).getAllByRole('row').slice(1).every((r) => r.children.length === headers.length)).toBe(true)
        expect(within(table).queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument()
    })

    it('lists every graph with its copy and marks forks, orphans and platform copies', async () => {
        const sent = serve({ graphs: [MAIN, FORK, ORPHAN], nextCursor: null })
        renderWithApi(<Inventory />)

        expect(await screen.findByText('Customer 360')).toBeInTheDocument()
        expect(screen.getByText('customer_360')).toBeInTheDocument()
        expect(within(screen.getByRole('table')).getAllByText('EU graph store')).toHaveLength(3)
        expect(screen.getByText('dsfork_1')).toBeInTheDocument()
        expect(screen.getByText('Fork')).toBeInTheDocument()
        expect(screen.getByText('Orphan')).toBeInTheDocument()
        expect(screen.getByText('Platform copy')).toBeInTheDocument()
        expect(screen.getAllByText('Connected graph')).toHaveLength(2)
        expect(screen.getByText('connection refused')).toBeInTheDocument()
        expect([...listCalls(sent)[0].query.keys()]).toEqual([])
        expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
    })

    it('pages on with the cursor and keeps the rows it has, out of the total the server counts', async () => {
        const sent = serve({ graphs: [MAIN], nextCursor: 'graph_a', total: 2 }, { graphs: [FORK], nextCursor: null, total: 2 })
        renderWithApi(<Inventory />)

        expect(await screen.findByText('1 of 2 graphs shown')).toBeInTheDocument()
        await userEvent.click(await screen.findByRole('button', { name: /load more/i }))
        expect(await screen.findByText('dsfork_1')).toBeInTheDocument()
        expect(screen.getByText('Customer 360')).toBeInTheDocument()
        expect(listCalls(sent).at(-1)?.query.get('cursor')).toBe('graph_a')
        expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
        expect(screen.getByText('2 of 2 graphs shown')).toBeInTheDocument()
    })

    it('without a count from the server, says only how many are shown', async () => {
        serve({ graphs: [MAIN], nextCursor: 'graph_a' })
        renderWithApi(<Inventory />)
        expect(await screen.findByText('1 graph shown, more to load')).toBeInTheDocument()
    })

    it('filters on the server by provider, status, kind, read mode, class, own settings and search', async () => {
        const sent = serve({ graphs: [MAIN], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        await userEvent.selectOptions(screen.getByLabelText('Provider'), 'falkor-eu')
        await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed')
        await userEvent.selectOptions(screen.getByLabelText('Kind'), 'orphan')
        await userEvent.selectOptions(screen.getByLabelText('Readers get'), 'beside')
        await userEvent.selectOptions(screen.getByLabelText('Class'), 'coldline')
        await userEvent.selectOptions(screen.getByLabelText('Own settings'), 'yes')
        await userEvent.type(screen.getByLabelText('Search'), 'customer{Enter}')

        await waitFor(() => expect(Object.fromEntries(listCalls(sent).at(-1)!.query)).toEqual({
            provider: 'falkor-eu', status: 'failed', kind: 'orphan', readModeEffective: 'beside', residency: 'coldline', ownSettings: 'true', q: 'customer',
        }))
    })

    it('rebuilds a graph and checks it against the database from its menu', async () => {
        serve({ graphs: [MAIN, FORK], nextCursor: null })
        rebuildProjection.mockResolvedValue({ started: true, alreadyRunning: false, watermark: {} })
        reconcileProjection.mockResolvedValue({
            inSync: false, skippedReason: null, missingNodes: [{ entityId: 'e1' }, { entityId: 'e2' }],
            extraNodes: [], missingEdges: [], extraEdges: ['x'], mismatched: [],
        })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        // A rebuild asks first, saying what it does.
        await userEvent.click(await menuItem('dsfork_1', /^Rebuild…/))
        let confirm = await screen.findByRole('dialog', { name: 'Rebuild this graph’s copy?' })
        expect(confirm).toHaveTextContent('dsfork_1’s copy in the graph store is written again from the database.')
        await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
        expect(rebuildProjection).not.toHaveBeenCalled()
        await userEvent.click(await menuItem('dsfork_1', /^Rebuild…/))
        confirm = await screen.findByRole('dialog', { name: 'Rebuild this graph’s copy?' })
        await userEvent.click(within(confirm).getByRole('button', { name: 'Rebuild' }))
        expect(rebuildProjection).toHaveBeenCalledWith('ws1', 'graph_b')
        expect(await screen.findByText('Rebuild started')).toBeInTheDocument()

        await userEvent.click(await menuItem('Customer 360', /^Check sync/))
        expect(reconcileProjection).toHaveBeenCalledWith('ws1', 'graph_a')
        expect(await screen.findByText('Out of sync: 2 missing, 1 extra')).toBeInTheDocument()
    })

    it('says a rebuild is built in a new copy, and what each build on a row is for', async () => {
        const rebuilding = row({ graphId: 'graph_r', dataSourceId: 'ds6', dataSourceLabel: 'Ledger', owned: true,
            readModeEffective: 'beside', build: { step: 'seeding', reason: 'rebuild', rebuild: 'operator' } })
        const moving = row({ graphId: 'graph_m', dataSourceId: 'ds7', dataSourceLabel: 'Invoices', owned: true,
            readModeEffective: 'beside', build: { step: 'catching_up', reason: 'move', target: { providerId: 'falkor-eu', key: 'gvp_graph_m{raph_m.2}' } } })
        const windowed = row({ graphId: 'graph_w', dataSourceId: 'ds8', dataSourceLabel: 'Shipments', owned: true,
            readModeEffective: 'beside', build: { step: 'seeding', reason: 'window' } })
        serve({ graphs: [rebuilding, moving, windowed], nextCursor: null })
        rebuildProjection.mockResolvedValue({ started: true, alreadyRunning: false, beside: true, watermark: {} })
        renderWithApi(<Inventory />)

        const chip = await screen.findByText('Rebuilding beside')
        expect(chip.getAttribute('title')).toMatch(/^The graph is rebuilt from the database in a new copy\. Readers keep exactly/)
        expect(chip.getAttribute('title')).not.toMatch(/as no copy fits/)
        expect(screen.getByText('Moving to gvp_graph_m{raph_m.2}').getAttribute('title')).toMatch(/written from the database into gvp_graph_m\{raph_m\.2\}/)
        expect(screen.getByText('Building from the database').getAttribute('title')).toMatch(/as no copy fits/)

        await userEvent.click(await menuItem('Ledger', /^Rebuild…/))
        await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild' }))
        expect(await screen.findByText('Rebuilding in a new copy: readers keep the current version until it is checked and switched to')).toBeInTheDocument()
    })

    it('says so when a check finds the copy in sync, and shows a refusal as given', async () => {
        serve({ graphs: [MAIN], nextCursor: null })
        reconcileProjection.mockResolvedValue({ inSync: true, skippedReason: null, missingNodes: [], extraNodes: [], missingEdges: [], extraEdges: [], mismatched: [] })
        rebuildProjection.mockRejectedValue(new Error('no projection target for this graph'))
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        await userEvent.click(await menuItem('Customer 360', /^Check sync/))
        expect(await screen.findByText('In sync with the database')).toBeInTheDocument()
        await userEvent.click(await menuItem('Customer 360', /^Rebuild…/))
        await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Rebuild' }))
        expect(await screen.findByText('no projection target for this graph')).toBeInTheDocument()
    })

    it("opens a graph's data source on its versioning tab, and only where there is one", async () => {
        serve({ graphs: [MAIN, FORK, ORPHAN], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        const gone = await menuItem('ds_gone', /^Open data source/)
        expect(gone).toHaveAttribute('aria-disabled', 'true')
        expect(gone).toHaveTextContent('Its data source no longer exists')
        await userEvent.keyboard('{Escape}')
        await userEvent.click(await menuItem('Customer 360', /^Open data source/))
        expect(screen.getByTestId('where')).toHaveTextContent('/workspaces/ws1?ds=ds1&dstab=versioning')
    })

    it("opens a fork's own data source", async () => {
        serve({ graphs: [FORK], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('dsfork_1')
        await userEvent.click(await menuItem('dsfork_1', /^Open data source/))
        expect(screen.getByTestId('where')).toHaveTextContent('/workspaces/ws1?ds=dsfork_1&dstab=versioning')
    })

    it('moves a fork to the trash from its menu on confirm, and offers it on forks only', async () => {
        const sent = serve({ graphs: [MAIN, FORK, ORPHAN], nextCursor: null })
        deleteFork.mockResolvedValue(undefined)
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        await userEvent.click(screen.getByRole('button', { name: 'More actions for Customer 360' }))
        expect(screen.queryByRole('menuitem', { name: /trash/ })).not.toBeInTheDocument()
        await userEvent.keyboard('{Escape}')

        await userEvent.click(await menuItem('dsfork_1', /trash/))
        const dialog = await screen.findByRole('dialog', { name: 'Move this fork to the trash?' })
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(deleteFork).not.toHaveBeenCalled()

        await userEvent.click(await menuItem('dsfork_1', /trash/))
        await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to trash' }))
        expect(deleteFork).toHaveBeenCalledWith('ws1', 'graph_b')
        expect(await screen.findByText('Moved to the trash; it can be restored from there')).toBeInTheDocument()
        await waitFor(() => expect(listCalls(sent)).toHaveLength(2))
    })

    it('shows a refused move to the trash as given', async () => {
        const sent = serve({ graphs: [FORK], nextCursor: null })
        deleteFork.mockRejectedValue(new Error('Forks were made from this fork. Delete its forks first.'))
        renderWithApi(<Inventory />)
        await screen.findByText('dsfork_1')

        await userEvent.click(await menuItem('dsfork_1', /trash/))
        await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Move to trash' }))
        expect(await screen.findByText('Forks were made from this fork. Delete its forks first.')).toBeInTheDocument()
        expect(listCalls(sent)).toHaveLength(1)
    })

    it("offers Move… on platform copies only, never on a connected graph or an orphan", async () => {
        serve({ graphs: [MAIN, FORK, { ...ORPHAN, owned: true }], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        const connected = await menuItem('Customer 360', /^Move…/)
        expect(connected).toHaveAttribute('aria-disabled', 'true')
        expect(connected).toHaveTextContent('Only platform copies move; this is a connected graph')
        await userEvent.keyboard('{Escape}')
        expect(await menuItem('ds_gone', /^Move…/)).toHaveAttribute('aria-disabled', 'true')
        await userEvent.keyboard('{Escape}')
        await userEvent.click(await menuItem('dsfork_1', /^Move…/))
        expect(await screen.findByRole('dialog')).toHaveTextContent('dsfork_1')
    })

    it('moves a graph from its menu, says where to, and reloads the list', async () => {
        const sent = serve({ graphs: [FORK], nextCursor: null })
        moveProjection.mockResolvedValue({
            graphId: 'graph_b', changed: true, from: { providerId: 'falkor-eu', key: 'gv_fork_b' },
            to: { providerId: 'falkor-eu', key: 'gvp_graph_b{graph_b.1}' }, retiring: null, watermark: {},
        })
        renderWithApi(<Inventory />)
        await screen.findByText('dsfork_1')

        await userEvent.click(await menuItem('dsfork_1', /^Move…/))
        await userEvent.selectOptions(await screen.findByLabelText('Target provider'), 'falkor-eu')
        await userEvent.click(screen.getByRole('button', { name: 'Move' }))
        expect(moveProjection).toHaveBeenCalledWith('graph_b', { providerId: 'falkor-eu' })
        expect(await screen.findByText('Moving to gvp_graph_b{graph_b.1}: reads come from the database until it catches up')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        await waitFor(() => expect(listCalls(sent)).toHaveLength(2))
    })

    it('says a move built beside the copy keeps readers on it, and when it is already under way or cancelled, with the rebuild it carried', async () => {
        serve({ graphs: [FORK], nextCursor: null })
        const from = { providerId: 'falkor-eu', key: 'gv_fork_b' }
        const to = { providerId: 'falkor-eu', key: 'gvp_graph_b{graph_b.2}' }
        const building = { id: 'build_1', step: 'seeding' as const, reason: 'move' as const, target: to }
        const answers = [
            [{ graphId: 'graph_b', changed: true, from, to, retiring: null, beside: true, building, cancelled: null, watermark: {} },
                `Building ${to.key} beside ${from.key}: readers stay on it until the new copy is checked and switched to`],
            [{ graphId: 'graph_b', changed: false, from, to, retiring: null, beside: true, building, cancelled: null, watermark: {} },
                `Already moving to ${to.key}`],
            [{ graphId: 'graph_b', changed: false, from, to: from, retiring: null, beside: false, building: null, cancelled: 'build_1', watermark: {} },
                'Move cancelled'],
            [{ graphId: 'graph_b', changed: false, from, to: from, retiring: null, beside: true,
                building: { id: 'build_2', step: 'queued' as const, reason: 'rebuild' as const }, cancelled: 'build_1', watermark: {} },
                `Move cancelled: the rebuild it carried goes on beside ${from.key}`],
        ] as const
        renderWithApi(<Inventory />)
        await screen.findByText('dsfork_1')
        for (const [answer, note] of answers) {
            moveProjection.mockResolvedValue(answer)
            await userEvent.click(await menuItem('dsfork_1', /^Move…/))
            await userEvent.selectOptions(await screen.findByLabelText('Target provider'), 'falkor-eu')
            await userEvent.click(screen.getByRole('button', { name: 'Move' }))
            expect(await screen.findByText(note)).toBeInTheDocument()
        }
    })

    it('says so when the graph already was there', async () => {
        serve({ graphs: [FORK], nextCursor: null })
        const here = { providerId: 'falkor-eu', key: 'gvp_graph_b{graph_b.1}' }
        moveProjection.mockResolvedValue({ graphId: 'graph_b', changed: false, from: here, to: here, retiring: null, watermark: {} })
        renderWithApi(<Inventory />)
        await screen.findByText('dsfork_1')

        await userEvent.click(await menuItem('dsfork_1', /^Move…/))
        await userEvent.selectOptions(await screen.findByLabelText('Target provider'), 'falkor-eu')
        await userEvent.click(screen.getByRole('button', { name: 'Move' }))
        expect(await screen.findByText('Already there')).toBeInTheDocument()
    })

    it("shows each graph's class and whether it is in memory, but none on a fork", async () => {
        const loading = row({ graphId: 'graph_e', dataSourceLabel: 'Loading one', residency: 'always', residencyState: 'rehydrating' })
        const waiting = row({ graphId: 'graph_f', dataSourceLabel: 'Waiting one', residencyState: 'waiting_capacity' })
        serve({ graphs: [MAIN, PLATFORM, loading, waiting, FORK], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        expect(rowOf('Customer 360').getByText(`Class: ${classTitle('standard')}`)).toBeInTheDocument()
        expect(rowOf('Customer 360').getByText('In memory')).toBeInTheDocument()
        expect(rowOf('Orders').getByText(`Class: ${classTitle('coldline')}`)).toBeInTheDocument()
        // Said once: its state is the row's state.
        expect(rowOf('Orders').getAllByText('Unloaded')).toHaveLength(1)
        expect(rowOf('Loading one').getByText(`Class: ${classTitle('always')}`)).toBeInTheDocument()
        expect(rowOf('Loading one').getByText('Loading')).toBeInTheDocument()
        expect(rowOf('Waiting one').getAllByText('Waiting for room').length).toBeGreaterThan(0)
        for (const c of CLASSES.choices) expect(rowOf('dsfork_1').queryByText(`Class: ${c.title}`)).not.toBeInTheDocument()
    })

    it('names why a graph cannot be adopted, offers no Adopt on a graph with no copy, and says it costs two copies', async () => {
        const unpinned = row({ graphId: 'graph_u', dataSourceId: 'ds_u', dataSourceLabel: 'Unpinned', falkorGraphName: null })
        const synthetic = row({ graphId: 'graph_s', dataSourceId: 'ds_s', dataSourceLabel: 'Synthetic', falkorGraphName: 'gv_graph_s' })
        serve({ graphs: [MAIN, unpinned, synthetic], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        for (const name of ['Unpinned', 'Synthetic']) {
            await userEvent.click(screen.getByRole('button', { name: `More actions for ${name}` }))
            expect(screen.queryByRole('menuitem', { name: /^Adopt…/ })).not.toBeInTheDocument()
            await userEvent.keyboard('{Escape}')
        }
        await userEvent.click(await menuItem('Customer 360', /^Adopt…/))
        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent('keeps its memory')
        expect(dialog).toHaveTextContent('two copies')
        expect(dialog).toHaveTextContent('the ontology’s spelling of each type')
        adoptGraph.mockRejectedValueOnce(Object.assign(new Error('409'), {
            status: 409, detail: { type: 'projection_not_adopted', reason: 'unpinned', message: 'this graph has no FalkorDB key yet; nothing to adopt' } }))
        await userEvent.click(within(dialog).getByRole('button', { name: 'Adopt' }))
        expect(await rowOf('Customer 360').findByText('This graph has no copy in the graph store yet, so there is nothing to adopt.')).toBeInTheDocument()
    })

    it('loads an unloaded graph now, and offers it only there', async () => {
        serve({ graphs: [MAIN, PLATFORM], nextCursor: null })
        loadGraph.mockResolvedValue({ graphId: 'graph_d', state: 'evicted', loadRequested: true })
        renderWithApi(<Inventory />)
        await screen.findByText('Orders')

        await userEvent.click(screen.getByRole('button', { name: 'More actions for Customer 360' }))
        expect(screen.queryByRole('menuitem', { name: 'Load now' })).not.toBeInTheDocument()
        await userEvent.keyboard('{Escape}')
        await userEvent.click(await menuItem('Orders', 'Load now'))
        expect(loadGraph).toHaveBeenCalledWith('graph_d')
        expect(await screen.findByText('Load asked for: it starts when its node has room')).toBeInTheDocument()
    })

    it("adopts a connected graph's copy after a confirmation that says what changes", async () => {
        const sent = serve({ graphs: [MAIN, PLATFORM, FORK], nextCursor: null })
        adoptGraph.mockResolvedValue({
            graphId: 'graph_a', from: { providerId: 'falkor-eu', key: 'customer_360' }, to: { providerId: 'falkor-eu', key: 'gvp_graph_a{raph_a.1}' },
        })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')

        for (const name of ['Orders', 'dsfork_1']) {
            await userEvent.click(screen.getByRole('button', { name: `More actions for ${name}` }))
            expect(screen.queryByRole('menuitem', { name: /^Adopt…/ })).not.toBeInTheDocument()   // platform copies and forks
            await userEvent.keyboard('{Escape}')
        }
        await userEvent.click(await menuItem('Customer 360', /^Adopt…/))
        let dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent('the platform reads its own copy')
        expect(dialog).toHaveTextContent('Changes other tools keep making to customer_360 no longer show here')
        expect(dialog).toHaveTextContent('Bring into history no longer sees them')
        expect(dialog).toHaveTextContent('customer_360 is left exactly as it is')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
        expect(adoptGraph).not.toHaveBeenCalled()

        await userEvent.click(await menuItem('Customer 360', /^Adopt…/))
        dialog = await screen.findByRole('dialog')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Adopt' }))
        expect(adoptGraph).toHaveBeenCalledWith('graph_a')
        expect(await screen.findByText('Adopting onto gvp_graph_a{raph_a.1}: reads come from the database until it catches up')).toBeInTheDocument()
        await waitFor(() => expect(listCalls(sent)).toHaveLength(2))
    })

    it('filters by graphs being loaded, waiting for room and building a new version', async () => {
        const sent = serve({ graphs: [MAIN], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')
        await userEvent.selectOptions(screen.getByLabelText('Status'), 'waiting_capacity')
        await waitFor(() => expect(listCalls(sent).at(-1)?.query.get('status')).toBe('waiting_capacity'))
        await userEvent.selectOptions(screen.getByLabelText('Status'), 'rehydrating')
        await waitFor(() => expect(listCalls(sent).at(-1)?.query.get('status')).toBe('rehydrating'))
        await userEvent.selectOptions(screen.getByLabelText('Status'), 'building')
        await waitFor(() => expect(listCalls(sent).at(-1)?.query.get('status')).toBe('building'))
    })

    it('says how many versions a graph is behind, and never rounds a copy up to written', async () => {
        const behind = row({ graphId: 'graph_l', dataSourceLabel: 'Lagging', lag: 3, committed: 9, projected: 6 })
        const seeding = row({ graphId: 'graph_s', dataSourceLabel: 'Seeding', owned: true, readModeEffective: 'beside',
            build: { step: 'seeding', reason: 'window', progress: { done: 996, total: 1000 } } })
        serve({ graphs: [behind, seeding], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Lagging')
        expect(rowOf('Lagging').getByText(/· 3 versions behind/)).toBeInTheDocument()
        expect(screen.getByText('Building from the database').getAttribute('title')).toMatch(/ 99% written\./)
    })

    it('shows the previous copy a moved graph is still retiring', async () => {
        serve({ graphs: [{ ...FORK, retiredKeys: [{ name: 'gv_fork_old', provider: 'falkor-eu', retireAfter: '2026-10-18T12:15:00Z', afterSeq: 5 }] }], nextCursor: null })
        renderWithApi(<Inventory />)
        expect(await screen.findByText('Previous copy gv_fork_old on EU graph store: removed once the new one catches up')).toBeInTheDocument()
    })

    it('names the default graph store, not "default"', async () => {
        serve({ graphs: [row({ falkorProvider: null })], nextCursor: null })
        renderWithApi(<Inventory />)
        await screen.findByText('Customer 360')
        expect(screen.getAllByText('Default graph store').some((el) => el.tagName === 'P')).toBe(true)
        expect(within(screen.getByLabelText('Provider')).getByRole('option', { name: 'Default graph store' })).toBeInTheDocument()
    })

    it('says what failed and offers to try again, and teaches when there is nothing yet', async () => {
        let fail = true
        mockApi('ok', (req) => (req.path.endsWith('/admin/versioning/graphs')
            ? fail ? json({ detail: 'The graph store didn’t answer in time' }, 503) : json({ graphs: [], nextCursor: null }) : undefined))
        renderWithApi(<Inventory />)
        expect(await screen.findByText(/Couldn’t list the graphs: The graph store didn’t answer in time/, {}, { timeout: 4000 })).toBeInTheDocument()
        fail = false
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByText('No versioned graphs yet')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Open workspaces' })).toBeInTheDocument()
    })
})
