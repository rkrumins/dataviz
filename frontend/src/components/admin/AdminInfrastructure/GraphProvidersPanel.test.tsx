/**
 * Memory headroom on the graph tier. Every MEASURABLE node is shown — the
 * rollup write budget reads this same used/maxmemory pair before every
 * rebuild — but the WORDS are reserved: a node with headroom carries no
 * level chip, a filling one must name itself, and a node that cannot be
 * measured (no cap, no memory section) stays silent.
 *
 * The same contract governs the fleet publish signal beside it, plus one
 * more: the causal claim tying a full node to a stalled publish may only be
 * made when a node is ACTUALLY at its cap.
 */
import { fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { GraphProvidersPanel } from './GraphProvidersPanel'

/** The panel links to Admin → Graph store, so it needs a router around it. */
const render = (node: React.ReactNode) => rtlRender(<MemoryRouter>{node}</MemoryRouter>)
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
  it('shows a shard with headroom, without a level word', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(standalone({
      usedMemory: 5_368_709_120, maxmemory: 12_884_901_888, memoryUsedPct: 41.7,
    }))} />)
    expect(screen.getByText('Primary graph')).toBeInTheDocument()
    expect(screen.getByText(/Memory headroom/i)).toBeInTheDocument()
    expect(screen.getByText(/5\.0 GB of 12\.0 GB \(42%\)/)).toBeInTheDocument()
    expect(screen.getByText(/1 shard with headroom/)).toBeInTheDocument()
    expect(screen.queryByText('Warning')).not.toBeInTheDocument()
    expect(screen.queryByText('Critical')).not.toBeInTheDocument()
  })

  it('marks the rollup reserve and says what still fits when the capacity sweep knows the node', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(standalone({
      usedMemory: 5_368_709_120, maxmemory: 12_884_901_888, memoryUsedPct: 41.7,
    }))} capacity={{
      limits: {
        shardReservePct: { value: 20, source: 'default' }, bytesPerEdge: { value: 512, source: 'default' },
        maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
        estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
      },
      shards: [{
        endpoint: 'falkordb:6379', used: 5_368_709_120, maxmemory: 12_884_901_888, policy: 'noeviction', measurable: true,
        usedPct: 41.7, reservePct: 20, reserveBytes: 2_576_980_377, availableBytes: 4_939_212_391,
        allowedGrowthEdges: 9_646_899, governedBy: 'shard', staticCap: 25_000_000, sources: [],
        reservedBytes: 1_288_490_189, reservedByJobs: 1,
      }],
      unresolved: [], sourcesTotal: 1, truncated: false, measuredAt: '2026-09-08T10:00:00Z', cacheAgeMs: 0,
    }} />)
    expect(screen.getByText(/Rollups keep 20% in reserve/)).toBeInTheDocument()
    expect(screen.getByText(/1\.2 GB held by 1 running rebuild/)).toBeInTheDocument()
    expect(screen.getByText(/fits ~9\.6M more rollup edges at 512 B each/)).toBeInTheDocument()
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
    // This one is held by the zero-count gate, exactly as the test above is —
    // it proves the block does not open, and deliberately says nothing about
    // the row filter, which never runs while nothing is lagging or failed.
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({
        fresh: 9, projecting: 2, rebuilding: 1, maxLag: 400,
        worst: [worst({ status: 'projecting', lag: 400 })],
      })} />)
    expect(screen.queryByText(/not publishing/i)).not.toBeInTheDocument()
  })

  it('leaves a working graph out of the list even when the block IS open', () => {
    // The exclusion the block's docstring claims lives in the ROW FILTER, and
    // the filter only runs once something is lagging or failed. Proved by
    // widening the filter to `lastError != null || lag > 0`: the whole
    // directory stayed green, so the clause was covered by nothing.
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor(HEALTHY_NODE)}
      projection={projection({
        fresh: 10, lagging: 1, maxLag: 400,
        worst: [
          worst({ graphId: 'g1', dataSourceLabel: 'Stalled One', status: 'idle', lag: 22 }),
          worst({ graphId: 'g2', dataSourceLabel: 'Rebuilding One', status: 'projecting', lag: 400 }),
        ],
      })} />)
    expect(screen.getByText('Graphs not publishing')).toBeInTheDocument()
    expect(screen.getByText('Stalled One')).toBeInTheDocument()
    expect(screen.queryByText('Rebuilding One')).not.toBeInTheDocument()
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

describe('GraphProvidersPanel — the node’s own limits', () => {
  const capacity = {
    limits: {
      shardReservePct: { value: 20, source: 'default' as const }, bytesPerEdge: { value: 512, source: 'default' as const },
      maxMaterializedEdges: { value: null, source: 'default' as const }, rollupStorage: { value: 'true', source: 'default' as const },
      estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
    },
    shards: [{
      endpoint: 'falkordb:6379', used: 5_368_709_120, maxmemory: 12_884_901_888, policy: 'noeviction', measurable: true,
      usedPct: 41.7, reservePct: 20, reserveBytes: 2_576_980_377, availableBytes: 4_939_212_391,
      allowedGrowthEdges: 9_646_899, governedBy: 'shard', staticCap: 25_000_000, sources: [],
      queryMemCapacity: 536_870_912, timeoutMaxMs: 180_000, threadCount: 4,
    }],
    unresolved: [], sourcesTotal: 1, truncated: false, measuredAt: '2026-09-09T10:00:00Z', cacheAgeMs: 0,
  }
  const probed = falkor(standalone({ usedMemory: 5_368_709_120, maxmemory: 12_884_901_888, memoryUsedPct: 41.7 }))

  it('names the per-query limits the capacity sweep read on the node', () => {
    render(<GraphProvidersPanel providers={PROVIDERS} services={probed} capacity={capacity} />)
    expect(screen.getByText(/Limits: per-query memory 512 MB · query time cap 180 s · 4 threads/)).toBeInTheDocument()
    // Without a handler there is nothing to click.
    expect(screen.queryByRole('button', { name: /adjust graph store limits/i })).not.toBeInTheDocument()
  })

  it('offers Adjust on a node the sweep placed, and only there', () => {
    const onAdjust = vi.fn()
    render(<GraphProvidersPanel providers={PROVIDERS} services={falkor({
      mode: 'cluster', shardsUp: 2, shardsTotal: 2,
      shards: [
        { endpoint: 'falkordb:6379', status: 'healthy', usedMemory: 5_368_709_120, maxmemory: 12_884_901_888, memoryUsedPct: 41.7, memoryLevel: null },
        { endpoint: '10.0.0.9:6379', status: 'healthy', usedMemory: 1_073_741_824, maxmemory: 12_884_901_888, memoryUsedPct: 8.3, memoryLevel: null },
      ],
    })} capacity={capacity} onAdjustLimits={onAdjust} />)
    const buttons = screen.getAllByRole('button', { name: /adjust graph store limits/i })
    expect(buttons).toHaveLength(1)            // the probe-only node has no client to reach it through
    fireEvent.click(buttons[0])
    expect(onAdjust).toHaveBeenCalledWith('falkordb:6379')
  })
})
