import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AggregationJobResponse } from '@/services/aggregationService'
import { NodeLoadPanel } from './NodeLoadPanel'
import type { DataSourceMeta } from './shared'

const meta = (label: string): DataSourceMeta => ({
    label, workspaceId: 'ws', workspaceName: 'ws', providerId: 'p',
    providerName: 'p', providerType: 'falkordb', graphName: 'g',
    projectionMode: 'in_source',
})

const run = (id: string, node: string, phase: string): AggregationJobResponse => ({
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
    currentPhase: phase,
    runStats: { node },
} as unknown as AggregationJobResponse)

const lookup = new Map([['ds-a', meta('Orders')], ['ds-b', meta('Payments')]])

describe('NodeLoadPanel', () => {
    it('answers "what else is writing this shard" by name and stage', () => {
        render(
            <NodeLoadPanel
                jobs={[run('a', '10.0.0.1:6379', 'applying'), run('b', '10.0.0.1:6379', 'extracting')]}
                dsLookup={lookup}
            />,
        )
        expect(screen.getByText('10.0.0.1:6379')).toBeInTheDocument()
        expect(screen.getByText('Orders')).toBeInTheDocument()
        expect(screen.getByText('Payments')).toBeInTheDocument()
        expect(screen.getByText('· Apply')).toBeInTheDocument()
        expect(screen.getByText('· Extract')).toBeInTheDocument()
    })

    it('flags a master more than one rebuild is writing, and says what that costs', () => {
        render(
            <NodeLoadPanel
                jobs={[run('a', '10.0.0.1:6379', 'applying'), run('b', '10.0.0.1:6379', 'applying')]}
                dsLookup={lookup}
            />,
        )
        expect(screen.getByText('sharing')).toBeInTheDocument()
        expect(screen.getByText(/each is slower than it would be alone/)).toBeInTheDocument()
    })

    it('says nothing about a node one rebuild has to itself', () => {
        render(<NodeLoadPanel jobs={[run('a', '10.0.0.1:6379', 'applying')]} dsLookup={lookup} />)
        expect(screen.queryByText('sharing')).toBeNull()
    })

    it('renders nothing at all when nothing is writing', () => {
        const { container } = render(<NodeLoadPanel jobs={[]} dsLookup={lookup} />)
        expect(container).toBeEmptyDOMElement()
    })
})
