/**
 * EVERY NODE, OR THE PAGE IS A LIE.
 *
 * The failure this page was built for: on a nine-node cluster (3 masters +
 * 6 replicas) the app showed three. The probe counted masters from the
 * environment's topology and the capacity card read only the nodes that
 * owned an aggregated graph, so replica memory, replication lag and the
 * graphs on each shard were not merely wrong — they were absent, and a node
 * missing from a list is indistinguishable from a node that does not exist.
 *
 * So these tests count. Nine rows in All nodes, three shard cards, every
 * replica with its lag, the node that did not answer impossible to scroll
 * past, and the words that tell "no maxmemory" apart from "not there".
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getTopology } = vi.hoisted(() => ({ getTopology: vi.fn() }))

vi.mock('@/services/graphStoreService', async () => {
    const actual = await vi.importActual<typeof import('@/services/graphStoreService')>('@/services/graphStoreService')
    return { ...actual, graphStoreService: { ...actual.graphStoreService, getTopology } }
})

import { useAuthStore } from '@/store/auth'
import type {
    GraphStoreInstance, GraphStoreNode, GraphStoreShard, GraphStoreTopologyResponse,
} from '@/services/graphStoreService'
import { AdminGraphStore } from './index'

const GB = 2 ** 30

function node(endpoint: string, over: Partial<GraphStoreNode> = {}): GraphStoreNode {
    return {
        endpoint,
        role: 'master',
        status: 'up',
        latencyMs: 1.2,
        memory: { used: 10 * GB, maxmemory: 40 * GB, policy: 'noeviction', usedPct: 25 },
        replication: { replicas: [], connectedReplicas: 2 },
        server: { uptimeS: 90_000, redisVersion: '8.6.3' },
        limits: { queryMemCapacity: 512 * 2 ** 20, timeoutMaxMs: 180_000, threadCount: 4, effectsThresholdUs: 300 },
        graphCount: 2,
        ...over,
    } as GraphStoreNode
}

function shard(index: number, lo: number, hi: number, over: Partial<GraphStoreShard> = {}): GraphStoreShard {
    const master = node(`10.0.0.${index + 1}:6379`)
    return {
        index,
        slotRanges: [[lo, hi]],
        slotCount: hi - lo + 1,
        master,
        replicas: [
            node(`10.0.1.${index + 1}:6379`, {
                role: 'replica',
                replication: { replicas: [], masterLinkStatus: 'up', lagBytes: 0 },
            }),
            node(`10.0.2.${index + 1}:6379`, {
                role: 'replica',
                replication: { replicas: [], masterLinkStatus: 'up', lagBytes: 1_288_490_188 },
            }),
        ],
        graphs: [
            {
                key: `graph_${index}`, slot: lo, present: true, role: 'source',
                dataSources: [{ id: `ds-${index}`, label: `Warehouse ${index}`, workspaceName: 'Data', edgeCount: 1000, aggregationStatus: 'ready' }],
                edgeCount: 1000, estimatedBytes: 512_000, measuredBytes: 640_000,
            },
        ],
        graphsTotal: 1,
        graphsTruncated: false,
        unregisteredCount: 0,
        replication: {
            replicasTotal: 2, replicasOnline: 2, maxLagBytes: 1_288_490_188, fullResyncs: 0,
            effectsThresholdUs: 300,
            findings: index === 0
                ? [{
                    code: 'effects_threshold_high', severity: 'warn',
                    text: 'Replicas re-run every rollup batch on their main thread.',
                    fix: 'Set the effects threshold to 0.', endpoint: '10.0.0.1:6379',
                }]
                : [],
        },
        capacity: {
            endpoint: master.endpoint, used: 10 * GB, maxmemory: 40 * GB, measurable: true,
            usedPct: 25, reservePct: 20, reserveBytes: 8 * GB, availableBytes: 22 * GB,
            allowedGrowthEdges: 46_000_000, governedBy: 'shard', staticCap: 25_000_000,
            reservedBytes: 0, reservedByJobs: 0, state: 'measured', sources: [],
        },
        ...over,
    } as GraphStoreShard
}

function instance(over: Partial<GraphStoreInstance> = {}): GraphStoreInstance {
    return {
        id: 'i1',
        providers: [{ id: 'p1', name: 'Primary graph', isActive: true }],
        envDefault: false,
        mode: 'cluster',
        seeds: ['10.0.0.1:6379'],
        seedUsed: '10.0.0.1:6379',
        discoveredVia: 'clusterNodes',
        reachable: true,
        slotsCovered: 16_384,
        shards: [shard(0, 0, 5460), shard(1, 5461, 10_922), shard(2, 10_923, 16_383)],
        totals: {
            masters: 3, replicas: 6, nodesUp: 9, nodesTotal: 9, graphs: 3,
            unregisteredGraphs: 0, usedMemory: 30 * GB, maxmemory: 120 * GB,
        },
        ...over,
    } as GraphStoreInstance
}

function snapshot(over: Partial<GraphStoreTopologyResponse> = {}): GraphStoreTopologyResponse {
    const inst = over.instances?.[0] ?? instance()
    return {
        instances: over.instances ?? [inst],
        summary: {
            instances: 1, providers: 1, masters: 3, replicas: 6, nodesUp: 9, nodesTotal: 9,
            graphs: 3, unregisteredGraphs: 0, usedMemory: 30 * GB, maxmemory: 120 * GB,
            unreachableNodes: 0, findings: 1,
        },
        limits: { shardReservePct: { value: 20, source: 'default' } } as never,
        measuredAt: '2026-09-09T10:00:00Z',
        cacheAgeMs: 0,
        ttlS: 30,
        stale: false,
        ...over,
    } as GraphStoreTopologyResponse
}

function wrap(initial = '/admin/graph-store') {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={[initial]}><AdminGraphStore /></MemoryRouter>
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    getTopology.mockResolvedValue(snapshot())
    useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

describe('Admin → Graph store', () => {
    it('shows all nine nodes of a three-shard cluster, not just its masters', async () => {
        wrap('/admin/graph-store?view=nodes')
        const table = await screen.findByTestId('graph-store-nodes-table')
        const rows = within(table).getAllByRole('row')
        expect(rows).toHaveLength(10)                 // one header + nine nodes
        for (const endpoint of [
            '10.0.0.1:6379', '10.0.0.2:6379', '10.0.0.3:6379',
            '10.0.1.1:6379', '10.0.1.2:6379', '10.0.1.3:6379',
            '10.0.2.1:6379', '10.0.2.2:6379', '10.0.2.3:6379',
        ]) {
            expect(within(table).getByText(endpoint)).toBeInTheDocument()
        }
        // And the strip says the same thing in words.
        expect(screen.getByText('9/9')).toBeInTheDocument()
        expect(screen.getByText('Master shards')).toBeInTheDocument()
        expect(screen.getByText('Replicas')).toBeInTheDocument()
    })

    it('lays out each shard with its slots, its replicas and how far behind they are', async () => {
        wrap()
        expect(await screen.findByTestId('shard-card-0')).toBeInTheDocument()
        expect(screen.getByTestId('shard-card-1')).toBeInTheDocument()
        expect(screen.getByTestId('shard-card-2')).toBeInTheDocument()

        const first = screen.getByTestId('shard-card-0')
        expect(within(first).getByText('slots 0–5460')).toBeInTheDocument()
        // On the lagging replica's own row, and again on the shard's summary.
        expect(within(first).getAllByText(/1\.2 GB behind/).length).toBeGreaterThanOrEqual(1)
        expect(within(first).getByText(/2 replicas · all online/)).toBeInTheDocument()
        // The rollup budget, in the words a rebuild uses.
        expect(within(first).getByText(/fits ~/)).toBeInTheDocument()
    })

    it('names the replication finding and offers the fix on the node it applies to', async () => {
        wrap()
        const first = await screen.findByTestId('shard-card-0')
        expect(within(first).getByText(/Replicas re-run every rollup batch/)).toBeInTheDocument()
        expect(within(first).getByText(/Set the effects threshold to 0/)).toBeInTheDocument()
        expect(within(first).getByRole('link', { name: /Adjust limits on 10\.0\.0\.1:6379/ }))
            .toBeInTheDocument()
    })

    it('lists a node that did not answer where it cannot be scrolled past', async () => {
        const broken = instance()
        broken.shards[1].master = node('10.0.0.2:6379', {
            status: 'unreachable', error: 'Connection refused', memory: {},
        })
        broken.totals = { ...broken.totals, nodesUp: 8 }
        getTopology.mockResolvedValue(snapshot({
            instances: [broken],
            summary: { ...snapshot().summary, nodesUp: 8, unreachableNodes: 1 },
        }))
        wrap()
        const block = await screen.findByTestId('graph-store-unreachable')
        expect(within(block).getByText('10.0.0.2:6379')).toBeInTheDocument()
        expect(within(block).getByText(/Connection refused/)).toBeInTheDocument()
        expect(within(block).getByText(/keep their checkpoint/)).toBeInTheDocument()
    })

    it('says when the cluster is not covering every slot', async () => {
        const partial = instance({ slotsCovered: 10_922, slotsMissing: '10923–16383' })
        getTopology.mockResolvedValue(snapshot({ instances: [partial] }))
        wrap()
        expect(await screen.findByText(/10,922\/16,384 slots covered/)).toBeInTheDocument()
        expect(screen.getByText(/missing 10923–16383/)).toBeInTheDocument()
    })

    it('finds a graph and the source that owns it', async () => {
        wrap()
        const first = await screen.findByTestId('shard-card-0')
        expect(within(first).getByText('graph_0')).toBeInTheDocument()
        expect(within(first).getByText('Warehouse 0')).toBeInTheDocument()

        const search = within(first).getByLabelText(/Search the graphs on shard 1/)
        await userEvent.type(search, 'nothing-like-this')
        expect(within(first).getByText(/Nothing on this shard matches/)).toBeInTheDocument()
    })

    it('keeps the search bounded — the collapse is not undone by typing', async () => {
        // On a shard at the two-thousand-row cap, one keystroke that bypassed
        // the collapse would mount two thousand rows — and again on the next.
        const many = snapshot()
        const shard = many.instances[0].shards[0]
        shard.graphs = Array.from({ length: 40 }, (_, i) => ({
            key: `graph_many_${i}`, slot: 1, present: true, role: 'source',
            dataSources: [], edgeCount: 10, estimatedBytes: 5120, measuredBytes: null,
        })) as never
        shard.graphsTotal = 40
        getTopology.mockResolvedValue(many)

        wrap()
        const card = await screen.findByTestId('shard-card-0')
        const search = within(card).getByLabelText(/Search the graphs on shard 1/)
        await userEvent.type(search, 'graph_many')

        // Every one of the forty matches, and twelve of them are mounted.
        expect(within(card).getAllByText(/^graph_many_/)).toHaveLength(12)
        expect(within(card).getByText(/Show all 40 matches/)).toBeInTheDocument()
    })

    it('says plainly when several provider rows share one store', async () => {
        // Memory and nodes belong to the store, not to a row. Two rows on
        // one cluster read as "Falkor A is using 30 GB" unless the card says
        // otherwise — and the fold that puts them on one card is exactly
        // what makes that reading available.
        const shared = snapshot()
        shared.instances[0].providers = [
            { id: 'p1', name: 'Falkor A', isActive: true },
            { id: 'p2', name: 'Falkor B', isActive: true },
        ]
        getTopology.mockResolvedValue(shared)
        wrap()
        const note = await screen.findByTestId('shared-store-note')
        expect(note.textContent).toMatch(/2 provider rows point at this one store/)
        expect(screen.getByText(/Falkor A, Falkor B/)).toBeInTheDocument()
    })

    it('never calls a store a default nobody configured', async () => {
        const orphan = snapshot()
        orphan.instances[0].providers = []
        orphan.instances[0].envDefault = true
        getTopology.mockResolvedValue(orphan)
        wrap()
        expect(await screen.findByText('Store with no provider')).toBeInTheDocument()
        expect(document.body.textContent ?? '').not.toContain('Default graph store')
    })

    it('rings the shard a deep link points at', async () => {
        wrap('/admin/graph-store?shard=i1:1')
        const focused = await screen.findByTestId('shard-card-1')
        expect(focused.className).toMatch(/ring-2/)
        expect(screen.getByTestId('shard-card-0').className).not.toMatch(/ring-2/)
    })

    it('offers the limits link only to a system administrator', async () => {
        wrap()
        expect(await screen.findByTestId('adjust-limits-10.0.0.1:6379')).toBeInTheDocument()

        useAuthStore.setState({ permissions: { global: [], ws: {} } } as never)
        wrap()
        expect(screen.queryByTestId('adjust-limits-10.0.0.2:6379')).not.toBeInTheDocument()
    })

    it('keeps the nodes on screen when the refresh behind them failed', async () => {
        getTopology.mockResolvedValue(snapshot({
            stale: true, lastError: 'no seed answered', cacheAgeMs: 42_000,
        }))
        wrap()
        expect(await screen.findByTestId('graph-store-stale-note')).toHaveTextContent(/no seed answered/)
        expect(screen.getByTestId('shard-card-0')).toBeInTheDocument()
    })

    it('explains every term on the page for someone who did not build the cluster', async () => {
        wrap()
        await userEvent.click(await screen.findByRole('button', { name: /How to read this page/ }))
        const glossary = screen.getByTestId('graph-store-glossary')
        expect(within(glossary).getByText('Shard and slot range')).toBeInTheDocument()
        expect(within(glossary).getByText('Effects threshold')).toBeInTheDocument()
        expect(within(glossary).getByText(/Cannot govern vs unreachable/)).toBeInTheDocument()
        expect(within(glossary).getByText(/Why a rebuild waits for replicas/)).toBeInTheDocument()
    })
})
