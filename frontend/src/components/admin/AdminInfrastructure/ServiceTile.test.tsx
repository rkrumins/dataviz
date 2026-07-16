/**
 * The backend probes compute topology facts (sentinel master, cluster shard
 * rollup, cache scope) — the tile must surface them, not drop them.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ServiceTile } from './ServiceTile'
import type { ServiceEntry } from '@/services/systemStatusService'

function svc(overrides: Partial<ServiceEntry>): ServiceEntry {
  return {
    key: 'falkordb',
    label: 'FalkorDB',
    status: 'healthy',
    latencyMs: 3.2,
    error: null,
    detail: {},
    ...overrides,
  } as ServiceEntry
}

describe('ServiceTile topology detail', () => {
  it('shows the sentinel mode badge and resolved master', () => {
    render(<ServiceTile svc={svc({
      detail: { mode: 'sentinel', master: '10.1.2.3:6379', graphCount: 4 },
    })} history={[]} />)
    expect(screen.getByText('sentinel')).toBeInTheDocument()
    expect(screen.getByText(/master 10\.1\.2\.3:6379/)).toBeInTheDocument()
    expect(screen.getByText(/4 graphs/)).toBeInTheDocument()
  })

  it('shows the cluster shard rollup', () => {
    render(<ServiceTile svc={svc({
      detail: { mode: 'cluster', shardsUp: 2, shardsTotal: 3, graphCount: 7 },
      status: 'degraded',
    })} history={[]} />)
    expect(screen.getByText('cluster')).toBeInTheDocument()
    expect(screen.getByText(/2\/3 shards/)).toBeInTheDocument()
  })

  it('standalone shows no topology badge', () => {
    render(<ServiceTile svc={svc({
      detail: { mode: 'standalone', graphCount: 1 },
    })} history={[]} />)
    expect(screen.queryByText('standalone')).not.toBeInTheDocument()
  })

  it('marks the cache probe as covering the global endpoint only', () => {
    render(<ServiceTile svc={svc({
      key: 'cacheRedis',
      label: 'Redis · Cache',
      detail: { scope: 'global', hitRate: 91.2 },
    })} history={[]} />)
    expect(screen.getByText('global endpoint')).toBeInTheDocument()
    expect(screen.getByText(/91\.2% hit rate/)).toBeInTheDocument()
  })
})
