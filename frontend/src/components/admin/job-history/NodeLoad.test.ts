import { describe, it, expect } from 'vitest'
import type { AggregationJobResponse } from '@/services/aggregationService'
import { nodeLoads, nodeOf } from './NodeLoad'

const run = (id: string, over: Record<string, unknown> = {}): AggregationJobResponse => ({
    id,
    dataSourceId: `ds-${id}`,
    status: 'running',
    triggerSource: 'manual',
    progress: 50,
    totalEdges: 0,
    processedEdges: 0,
    createdEdges: 0,
    batchSize: 1000,
    resumable: false,
    retryCount: 0,
    createdAt: '2026-09-12T00:00:00Z',
    ...over,
} as unknown as AggregationJobResponse)

const on = (id: string, node: string, status = 'running') =>
    run(id, { status, runStats: { node } })

describe('nodeOf', () => {
    it('reads the node the run named', () => {
        expect(nodeOf(on('a', '10.0.0.1:6379'))).toBe('10.0.0.1:6379')
    })

    it('has nothing to say for a run that has not named one', () => {
        expect(nodeOf(run('a'))).toBeNull()
        expect(nodeOf(run('a', { runStats: {} }))).toBeNull()
        expect(nodeOf(run('a', { runStats: { node: '' } }))).toBeNull()
    })
})

describe('nodeLoads', () => {
    it('groups the running rebuilds by the master they write', () => {
        const loads = nodeLoads([
            on('a', '10.0.0.1:6379'),
            on('b', '10.0.0.2:6379'),
            on('c', '10.0.0.1:6379'),
        ])
        expect(loads.map(l => [l.node, l.runs.length, l.shared])).toEqual([
            ['10.0.0.1:6379', 2, true],
            ['10.0.0.2:6379', 1, false],
        ])
    })

    it('orders by busiest, then by address so polls do not reshuffle it', () => {
        const loads = nodeLoads([on('a', '10.0.0.9:6379'), on('b', '10.0.0.2:6379')])
        expect(loads.map(l => l.node)).toEqual(['10.0.0.2:6379', '10.0.0.9:6379'])
    })

    it('counts only what is actually writing', () => {
        expect(nodeLoads([
            on('a', '10.0.0.1:6379', 'completed'),
            on('b', '10.0.0.1:6379', 'pending'),
            on('c', '10.0.0.1:6379', 'failed'),
        ])).toEqual([])
    })

    it('leaves out a run that has not named its node', () => {
        // Still preparing, or a store that cannot be measured. A list of
        // nodes with a phantom entry in it is worse than a shorter list.
        const loads = nodeLoads([run('a'), on('b', '10.0.0.1:6379')])
        expect(loads).toHaveLength(1)
        expect(loads[0].runs.map(r => r.id)).toEqual(['b'])
    })
})
