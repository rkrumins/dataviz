/**
 * "WHICH NODE IS THIS SOURCE ON?" — ANSWERED WHERE THE SOURCE IS.
 *
 * A graph lives on exactly one node, chosen by hashing its key, and in
 * dedicated projection mode its rollups live on a DIFFERENT key that can
 * hash to a different shard. No screen said any of that, so a source that
 * kept failing on a full node looked identical to one that was fine, and
 * "the graph store restarted" could not be connected to the source in front
 * of you.
 */
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPlacement, getProviderTopology } = vi.hoisted(() => ({
    getPlacement: vi.fn(),
    getProviderTopology: vi.fn(),
}))

vi.mock('@/services/graphStoreService', async () => {
    const actual = await vi.importActual<typeof import('@/services/graphStoreService')>('@/services/graphStoreService')
    return {
        ...actual,
        graphStoreService: { ...actual.graphStoreService, getPlacement, getProviderTopology },
    }
})

import type { GraphPlacementResponse, GraphStoreNode, ProviderTopologyResponse } from '@/services/graphStoreService'
import { GraphStorePlacementCard } from './GraphStorePlacementCard'
import { ProviderTopologyBlock, ProviderTopologyLine } from './ProviderTopologyBlock'

const GB = 2 ** 30

function node(endpoint: string, over: Partial<GraphStoreNode> = {}): GraphStoreNode {
    return {
        endpoint, role: 'master', status: 'up',
        memory: { used: 30 * GB, maxmemory: 40 * GB, usedPct: 75 },
        replication: { replicas: [], connectedReplicas: 2 },
        server: { uptimeS: 90_000 },
        limits: {},
        ...over,
    } as GraphStoreNode
}

const PLACEMENT: GraphPlacementResponse = {
    dataSourceId: 'ds-1',
    providerId: 'p1',
    providerName: 'Primary graph',
    instanceId: 'i1',
    mode: 'cluster',
    reachable: true,
    placements: [
        {
            graphKey: 'warehouse', role: 'source', slot: 1234, shardIndex: 0, present: true,
            master: node('10.0.0.1:6379'),
            replicas: [
                node('10.0.1.1:6379', { role: 'replica', replication: { replicas: [], masterLinkStatus: 'up', lagBytes: 0 } }),
            ],
            siblings: 4, siblingsSample: [], edgeCount: 1_200_000,
            estimatedBytes: 600_000_000, measuredBytes: 640_000_000,
        },
    ],
    totals: { masters: 3, replicas: 6, nodesUp: 9, nodesTotal: 9, graphs: 5, unregisteredGraphs: 0 },
    cacheAgeMs: 0,
    stale: false,
}

const TOPOLOGY: ProviderTopologyResponse = {
    providerId: 'p1',
    providerName: 'Primary graph',
    instance: {
        id: 'i1', providers: [{ id: 'p1', name: 'Primary graph', isActive: true }],
        envDefault: false, mode: 'cluster', seeds: ['10.0.0.1:6379'], reachable: true,
        slotsCovered: 16_384,
        shards: [{
            index: 0, slotRanges: [[0, 16_383]], slotCount: 16_384,
            master: node('10.0.0.1:6379'),
            replicas: [node('10.0.1.1:6379', { role: 'replica', replication: { replicas: [], masterLinkStatus: 'up', lagBytes: 0 } })],
            graphs: [], graphsTotal: 0, graphsTruncated: false, unregisteredCount: 0,
            replication: { replicasTotal: 1, replicasOnline: 1, findings: [] },
        }],
        totals: { masters: 3, replicas: 6, nodesUp: 9, nodesTotal: 9, graphs: 5, unregisteredGraphs: 0 },
    },
    cacheAgeMs: 0,
    stale: false,
}

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    getPlacement.mockResolvedValue(PLACEMENT)
    getProviderTopology.mockResolvedValue(TOPOLOGY)
})

describe('a data source’s placement', () => {
    it('names the node, its shard, its replicas and what shares it', async () => {
        wrap(<GraphStorePlacementCard dataSourceId="ds-1" />)
        const card = await screen.findByTestId('graph-store-placement')
        expect(within(card).getByText('warehouse')).toBeInTheDocument()
        expect(within(card).getByText(/Shard 1 · slot 1,234/)).toBeInTheDocument()
        expect(within(card).getByText('10.0.0.1:6379')).toBeInTheDocument()
        expect(within(card).getByText(/sharing the shard with 4 other graphs/)).toBeInTheDocument()
        expect(within(card).getByText(/1 replica: 10\.0\.1\.1:6379 \(in step\)/)).toBeInTheDocument()
        expect(within(card).getByRole('link', { name: 'Open in Graph store' }))
            .toHaveAttribute('href', '/admin/graph-store?shard=i1%3A0')
    })

    it('says when the rollups live on a different shard than the source graph', async () => {
        getPlacement.mockResolvedValue({
            ...PLACEMENT,
            placements: [
                PLACEMENT.placements[0],
                {
                    ...PLACEMENT.placements[0], graphKey: 'warehouse_proj', role: 'projection',
                    slot: 9999, shardIndex: 1, master: node('10.0.0.2:6379'), replicas: [],
                },
            ],
        })
        wrap(<GraphStorePlacementCard dataSourceId="ds-1" />)
        const card = await screen.findByTestId('graph-store-placement')
        expect(within(card).getByText('warehouse_proj')).toBeInTheDocument()
        expect(within(card).getByText('rollup projection')).toBeInTheDocument()
        expect(within(card).getByText(/rollups are on a different shard/)).toBeInTheDocument()
    })

    it('says so plainly when no shard holds the slot', async () => {
        getPlacement.mockResolvedValue({
            ...PLACEMENT,
            placements: [{ ...PLACEMENT.placements[0], master: null, shardIndex: null, replicas: [] }],
        })
        wrap(<GraphStorePlacementCard dataSourceId="ds-1" />)
        const card = await screen.findByTestId('graph-store-placement')
        expect(within(card).getByText(/No shard of this graph store holds slot 1,234/))
            .toBeInTheDocument()
    })
})

describe('a provider’s own nodes', () => {
    it('says what the connection reaches, not what was configured', async () => {
        wrap(<ProviderTopologyLine providerId="p1" />)
        const line = await screen.findByTestId('provider-topology-line')
        expect(line).toHaveTextContent('cluster')
        expect(line).toHaveTextContent('3 master shards')
        expect(line).toHaveTextContent('6 replicas')
        expect(line).toHaveTextContent('9/9 nodes up')
        expect(line).toHaveTextContent('16,384/16,384 slots')
    })

    it('lists every node of the instance when expanded', async () => {
        wrap(<ProviderTopologyBlock providerId="p1" />)
        const block = await screen.findByTestId('provider-topology-block')
        expect(within(block).getByText('10.0.0.1:6379')).toBeInTheDocument()
        expect(within(block).getByText('10.0.1.1:6379')).toBeInTheDocument()
        expect(within(block).getByRole('link', { name: 'Open in Graph store' }))
            .toHaveAttribute('href', '/admin/graph-store')
    })

    it('says what share of its reads replicas actually answered', async () => {
        getProviderTopology.mockResolvedValue({
            ...TOPOLOGY, reads: { replicaReads: 62, masterReads: 38, replicaFallbacks: 0 },
        })
        wrap(<ProviderTopologyLine providerId="p1" />)
        expect(await screen.findByTestId('provider-topology-line'))
            .toHaveTextContent('62% of reads from replicas')
    })

    it('says nothing about routing until there are enough reads to mean anything', async () => {
        getProviderTopology.mockResolvedValue({
            ...TOPOLOGY, reads: { replicaReads: 2, masterReads: 1, replicaFallbacks: 0 },
        })
        wrap(<ProviderTopologyLine providerId="p1" />)
        expect(await screen.findByTestId('provider-topology-line'))
            .not.toHaveTextContent('reads from replicas')
    })

    it('stays quiet rather than guessing when the provider has no instance', async () => {
        getProviderTopology.mockResolvedValue({ ...TOPOLOGY, instance: null, lastError: 'no seed answered' })
        wrap(<><ProviderTopologyLine providerId="p1" /><ProviderTopologyBlock providerId="p1" /></>)
        expect(await screen.findByTestId('provider-topology-line'))
            .toHaveTextContent('no seed answered')
        expect(screen.queryByTestId('provider-topology-block')).not.toBeInTheDocument()
    })
})
