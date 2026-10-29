/**
 * The graphs on a shard, marked with the versioned graph that writes into
 * each key. A fork's key is claimed by no data source, and used to read as
 * "no data source claims it" — the words for a leftover to clean up — on a
 * key the platform is serving. A key the projector evicted is not "missing".
 */
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { GraphOnShard, GraphStoreNode, GraphStoreShard } from '@/services/graphStoreService'
import { ShardCard } from './ShardCard'

const MASTER = {
    endpoint: '10.0.0.1:6379', role: 'master', status: 'up',
    memory: { used: 2 ** 30, maxmemory: 4 * 2 ** 30 }, replication: { replicas: [] },
    server: {}, limits: {}, commandStats: {},
} as unknown as GraphStoreNode

function graph(key: string, over: Partial<GraphOnShard> = {}): GraphOnShard {
    return { key, slot: 1, present: true, role: 'source', dataSources: [], edgeCount: 0, ...over }
}

function card(graphs: GraphOnShard[]) {
    const shard = {
        index: 0, slotRanges: [[0, 16383]], slotCount: 16384, master: MASTER, replicas: [],
        graphs, graphsTotal: graphs.length, graphsTruncated: false,
        unregisteredCount: graphs.filter(g => g.role === 'unregistered').length,
        replication: { replicasTotal: 0, replicasOnline: 0, findings: [] },
    } as GraphStoreShard
    render(<MemoryRouter><ShardCard shard={shard} instanceId="i1" /></MemoryRouter>)
}

const row = (key: string) => screen.getByText(key).closest('tr') as HTMLElement

describe('ShardCard — versioned graphs', () => {
    it('attributes a fork key to its versioned graph and says how far behind it is', () => {
        card([graph('customer__fork_gf1', {
            role: 'versioned',
            versioned: { graphId: 'gf1', kind: 'fork', owned: true, status: 'idle', lag: 3 },
        })])
        const fork = row('customer__fork_gf1')
        expect(within(fork).getByText('fork gf1')).toBeInTheDocument()
        expect(within(fork).getByText('Fork · Platform copy')).toBeInTheDocument()
        expect(within(fork).getByText('3 commits behind')).toBeInTheDocument()
        expect(within(fork).queryByText(/no data source claims it/)).not.toBeInTheDocument()
        expect(screen.queryByText(/unregistered/)).not.toBeInTheDocument()
    })

    it('marks a data source key a versioned graph writes into, and whose it is', () => {
        card([graph('customer', {
            dataSources: [{ id: 'ds1', label: 'Customer 360', edgeCount: 10, aggregationStatus: 'ready' }],
            versioned: { graphId: 'gm', kind: 'main', owned: false, status: 'projecting', lag: 1 },
        })])
        const main = row('customer')
        expect(within(main).getByText('Customer 360')).toBeInTheDocument()
        expect(within(main).getByText('Versioned · Customer graph')).toBeInTheDocument()
        expect(within(main).getByText('projecting')).toBeInTheDocument()
    })

    it('calls an evicted key evicted, not missing from the node', () => {
        card([graph('customer__fork_gf2', {
            present: false, role: 'versioned',
            versioned: { graphId: 'gf2', kind: 'fork', owned: true, status: 'evicted', lag: 0 },
        })])
        const evicted = row('customer__fork_gf2')
        expect(within(evicted).getByText('evicted')).toBeInTheDocument()
        expect(within(evicted).queryByText('not found on the node')).not.toBeInTheDocument()
    })

    it('still says nobody claims a key no data source or versioned graph writes into', () => {
        card([graph('stray', { role: 'unregistered' })])
        expect(within(row('stray')).getByText('no data source claims it')).toBeInTheDocument()
        expect(screen.getByText('1 unregistered')).toBeInTheDocument()
    })
})
