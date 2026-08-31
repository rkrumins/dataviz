/**
 * Memory headroom on the graph tier. The page is read at a glance, so the
 * contract is as much about SILENCE as about the warning: nothing renders
 * while every shard has headroom, while a filling shard must name itself.
 *
 * The same contract governs the fleet publish signal beside it, plus one
 * more: the causal claim tying a full node to a stalled publish may only be
 * made when a node is ACTUALLY at its cap.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GraphProvidersPanel } from './GraphProvidersPanel'
import type { GraphProvider, ProjectionSection, ProjectionWorstRow, ServiceEntry } from '@/services/systemStatusService'

const PROVIDERS: GraphProvider[] = [
  { id: 'p1', name: 'Primary graph', type: 'falkordb', status: 'healthy', error: null, isActive: true },
]

function falkor(detail: Record<string, unknown>, status: ServiceEntry['status'] = 'healthy'): ServiceEntry[] {
  return [
    { key: 'busRedis', label: 'Redis · Bus', status: 'healthy', latencyMs: 1, error: null, detail: {} },
    { key: 'falkordb', label: 'FalkorDB', status, latencyMs: 2, error: null, detail },
  ]
}

/** Standalone/sentinel carry the memory fields flat on ``detail``. */
function standalone(overrides: Record<string, unknown>): Record<string, unknown> {
  return { mode: 'standalone', endpoint: 'falkordb:6379', graphCount: 4, ...overrides }
}

describe('GraphProvidersPanel — memory headroom', () => {
  it('says nothing while the shard has headroom', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(standalone({
      usedMemory: 5_368_709_120, maxmemory: 12_884_901_888, memoryUsedPct: 41.7,
    }))} />)
    expect(screen.getByText('Primary graph')).toBeInTheDocument()
    expect(screen.queryByText(/Memory headroom/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/41/)).not.toBeInTheDocument()
  })

  it('warns with the node, the bytes against the cap, and the percentage', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(standalone({
      usedMemory: 11_260_805_939, maxmemory: 12_884_901_888, memoryUsedPct: 87.4,
      memoryPressure: { level: 'warn', usedPct: 87.4, scope: 'falkordb:6379' },
    }), 'degraded')} />)
    expect(screen.getByText(/Memory headroom/i)).toBeInTheDocument()
    expect(screen.getByText('falkordb:6379')).toBeInTheDocument()
    expect(screen.getByText(/10\.5 GB of 12\.0 GB \(87%\)/)).toBeInTheDocument()
    // Never colour alone: the level is a word, not just an amber pixel.
    expect(screen.getByText('Warning')).toBeInTheDocument()
    // The consequence belongs to the critical level only.
    expect(screen.queryByText(/refuses writes/i)).not.toBeInTheDocument()
  })

  it('states the consequence at the critical level', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(standalone({
      usedMemory: 12_253_536_256, maxmemory: 12_884_901_888, memoryUsedPct: 95.1,
      memoryPressure: { level: 'critical', usedPct: 95.1, scope: 'falkordb:6379' },
    }), 'degraded')} />)
    expect(screen.getByText(/11\.4 GB of 12\.0 GB \(95%\)/)).toBeInTheDocument()
    expect(screen.getByText('Critical')).toBeInTheDocument()
    expect(screen.getByText(/refuses writes/i)).toBeInTheDocument()
    expect(screen.getByText(/lineage/i)).toBeInTheDocument()
  })

  it('stays silent on an uncapped node (maxmemory 0 is unlimited, not full)', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(standalone({
      usedMemory: 10_729_703_536, maxmemory: 0, memoryUsedPct: null,
    }))} />)
    expect(screen.queryByText(/Memory headroom/i)).not.toBeInTheDocument()
  })

  it('stays silent when the node answered with no memory section at all', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(standalone({}))} />)
    expect(screen.queryByText(/Memory headroom/i)).not.toBeInTheDocument()
  })

  it('names the one filling shard and still shows where the room is', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor({
      mode: 'cluster',
      shardsUp: 3,
      shardsTotal: 3,
      shards: [
        { endpoint: '10.0.0.1:6379', status: 'healthy', usedMemory: 12_884_901_888, maxmemory: 42_949_672_960, memoryUsedPct: 30, memoryLevel: null },
        { endpoint: '10.0.0.2:6379', status: 'healthy', usedMemory: 41_231_686_042, maxmemory: 42_949_672_960, memoryUsedPct: 96, memoryLevel: 'critical' },
        { endpoint: '10.0.0.3:6379', status: 'healthy', usedMemory: 21_474_836_480, maxmemory: 42_949_672_960, memoryUsedPct: 50, memoryLevel: null },
      ],
    }, 'degraded')} />)
    expect(screen.getByText('10.0.0.2:6379')).toBeInTheDocument()
    expect(screen.getByText(/38\.4 GB of 40\.0 GB \(96%\)/)).toBeInTheDocument()
    expect(screen.getByText('Critical')).toBeInTheDocument()
    // The healthy shards are listed too — "move a graph to another shard"
    // is unanswerable without knowing which shard has room.
    expect(screen.getByText('10.0.0.1:6379')).toBeInTheDocument()
    expect(screen.getByText('10.0.0.3:6379')).toBeInTheDocument()
    expect(screen.getByText('1 of 3 shards filling')).toBeInTheDocument()
    // …but only the filling one is levelled.
    expect(screen.getAllByText('Critical')).toHaveLength(1)
  })

  it('shows a filling shard even when no provider rows are registered', () => {
    render(<GraphProvidersPanel providers={[]} services={falkor(standalone({
      usedMemory: 12_253_536_256, maxmemory: 12_884_901_888, memoryUsedPct: 95.1,
      memoryPressure: { level: 'critical' },
    }), 'degraded')} />)
    expect(screen.getByText(/Memory headroom/i)).toBeInTheDocument()
  })

  it('renders providers unchanged when the graph tier was never probed', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={[]} />)
    expect(screen.getByText('Primary graph')).toBeInTheDocument()
    expect(screen.queryByText(/Memory headroom/i)).not.toBeInTheDocument()
  })
})

// ── Fleet publish health ───────────────────────────────────────────

function worst(over: Partial<ProjectionWorstRow>): ProjectionWorstRow {
  return {
    graphId: 'g1', workspaceId: 'ws1', workspaceName: 'Sales',
    dataSourceId: 'ds_1', dataSourceLabel: 'Customer 360',
    providerName: null, providerType: 'falkordb', kind: 'authoritative',
    falkorGraphName: 'gv_1', falkorProvider: 'p1',
    committed: 902, projected: 880, target: null,
    lag: 22, status: 'idle', lastError: null, lastProjectedAt: null,
    progressDone: null, progressTotal: null, updatedAt: null,
    ...over,
  }
}

function projection(over: Partial<ProjectionSection>): ProjectionSection {
  return {
    totalGraphs: 12, fresh: 12, lagging: 0, projecting: 0, rebuilding: 0,
    evicted: 0, failed: 0, maxLag: 0, worst: [], ...over,
  }
}

const HEALTHY_NODE = standalone({
  usedMemory: 5_368_709_120, maxmemory: 12_884_901_888, memoryUsedPct: 41.7,
})

const FULL_NODE = standalone({
  usedMemory: 12_253_536_256, maxmemory: 12_884_901_888, memoryUsedPct: 95.1,
  memoryPressure: { level: 'critical', usedPct: 95.1, scope: 'falkordb:6379' },
})

describe('GraphProvidersPanel — graphs not publishing', () => {
  it('says nothing while every graph is projected to its head', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({ fresh: 12 })} />)
    expect(screen.getByText('Primary graph')).toBeInTheDocument()
    expect(screen.queryByText(/not publishing/i)).not.toBeInTheDocument()
  })

  it('stays silent for graphs that are actively projecting or rebuilding', () => {
    // Working is not wedged: a rebuild in flight must not raise the block.
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({
        fresh: 9, projecting: 2, rebuilding: 1, maxLag: 400,
        worst: [worst({ status: 'projecting', lag: 400 })],
      })} />)
    expect(screen.queryByText(/not publishing/i)).not.toBeInTheDocument()
  })

  it('names the stalled graph, how far behind, and which cache hosts it', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({ fresh: 11, lagging: 1, maxLag: 22, worst: [worst({})] })} />)
    expect(screen.getByText('Graphs not publishing')).toBeInTheDocument()
    expect(screen.getByText('Customer 360')).toBeInTheDocument()
    expect(screen.getByText('22 commits behind')).toBeInTheDocument()
    // The read cache is named by the provider CARD's own label, not its id.
    expect(screen.getByText('on Primary graph')).toBeInTheDocument()
    expect(screen.getByText('1 of 12 versioned graphs')).toBeInTheDocument()
  })

  it('shows the projector\u2019s own error verbatim and reads as erroring', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({
        fresh: 11, failed: 1, maxLag: 22,
        worst: [worst({ lastError: 'verify mismatch at seq 902' })],
      })} />)
    expect(screen.getByText('verify mismatch at seq 902')).toBeInTheDocument()
    expect(screen.getByText('1 erroring')).toBeInTheDocument()
  })

  it('does not blame memory when no node is at its cap', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({ fresh: 11, lagging: 1, maxLag: 22, worst: [worst({})] })} />)
    expect(screen.queryByText(/memory cap/i)).not.toBeInTheDocument()
    expect(screen.getByText(/reads fall back to the version log/i)).toBeInTheDocument()
  })

  it('states the causal pair when a node IS at its cap — full AND not publishing', () => {
    // The 14-hour outage: writes refused, reads fine, so trace worked while
    // aggregation did not. Both halves must be on screen together.
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(FULL_NODE, 'degraded')}
      projection={projection({ fresh: 9, lagging: 2, failed: 1, maxLag: 22, worst: [worst({})] })} />)
    expect(screen.getByText(/Memory headroom/i)).toBeInTheDocument()
    expect(screen.getByText('falkordb:6379')).toBeInTheDocument()
    expect(screen.getByText('Graphs not publishing')).toBeInTheDocument()
    expect(screen.getByText(/at its memory cap/i)).toBeInTheDocument()
    expect(screen.getByText(/refusing writes/i)).toBeInTheDocument()
    expect(screen.getByText(/reads keep working/i)).toBeInTheDocument()
    expect(screen.getByText('3 of 12 versioned graphs')).toBeInTheDocument()
  })

  it('reports the fleet count, not the capped row list', () => {
    // The probe caps its worst list; deriving the count from the rows would
    // under-report a fleet-wide outage as exactly the cap.
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({
        totalGraphs: 40, fresh: 9, lagging: 31, maxLag: 22,
        worst: [worst({}), worst({ graphId: 'g2', dataSourceLabel: 'Orders' })],
      })} />)
    expect(screen.getByText('31 of 40 versioned graphs')).toBeInTheDocument()
    expect(screen.getByText(/29 more not listed/)).toBeInTheDocument()
  })

  it('renders on the standalone shape with no provider rows registered', () => {
    render(<GraphProvidersPanel providers={[]} services={falkor(standalone({}))}
      projection={projection({ fresh: 11, lagging: 1, worst: [worst({ falkorProvider: null })] })} />)
    expect(screen.getByText('Graphs not publishing')).toBeInTheDocument()
    expect(screen.getByText('Customer 360')).toBeInTheDocument()
  })

  it('says nothing when the projection probe itself returned nothing', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)} projection={null} />)
    expect(screen.queryByText(/not publishing/i)).not.toBeInTheDocument()
  })
})
