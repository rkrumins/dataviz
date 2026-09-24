/**
 * useSubsetGrow — growing picks along lineage: within the view at its own
 * grain, a finer pick by asking the walk, and beyond the view by one raw
 * step filed under the pick's grain and placed by the view's rules.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers', async (original) => ({
  ...(await original<typeof import('@/providers')>()),
  useGraphProvider: () => holder.current,
}))

import type { LayerAssignmentRule } from '@/providers/GraphDataProvider'

import { useSubsetStudioStore, type SubsetPick } from '../../model/studioStore'
import { useSubsetGrow, type SourceMember } from '../useSubsetGrow'

const member = (urn: string, layerId: string): SourceMember =>
  ({ urn, layerId, inheritsChildren: true, label: urn, entityType: 'table' })
const pick = (urn: string, layerId: string, over: Partial<SubsetPick> = {}): SubsetPick =>
  ({ urn, layerId, inheritsChildren: true, origin: 'picked', label: urn, entityType: 'table', ...over })

// raw: A, B · staging: C · marts: D ; A → C → D, B → C
const sourceMembers = new Map([
  ['A', member('A', 'raw')], ['B', member('B', 'raw')], ['C', member('C', 'staging')], ['D', member('D', 'marts')],
])
const sourceLinks = [
  { source: 'A', target: 'C', hops: 2 }, { source: 'B', target: 'C', hops: 1 }, { source: 'C', target: 'D', hops: 3 },
]
const layerOrder = ['raw', 'staging', 'marts']
const rules: LayerAssignmentRule[] = [{ id: 'r', layerId: 'marts', entityTypes: ['dashboard'], priority: 10 }]

function mountGrow() {
  return renderHook(() => useSubsetGrow({ sourceMembers, sourceLinks, maxHops: 10, layerOrder, layerRules: rules })).result.current
}

beforeEach(() => { sessionStorage.clear(); useSubsetStudioStore.getState().open('v') })
afterEach(() => { useSubsetStudioStore.getState().close({ discard: true }); holder.current = {} })

describe('useSubsetGrow', () => {
  it('within the view: one step is the nearest members, placed where the view has them', async () => {
    useSubsetStudioStore.getState().toggle(pick('C', 'staging'))
    const out = await mountGrow().grow('upstream', 'one')
    expect(out.additions.map(a => [a.urn, a.layerId, a.origin])).toEqual([['A', 'raw', 'grown-up'], ['B', 'raw', 'grown-up']])
  })

  it('within the view: all follows lineage to the view\'s edge', async () => {
    useSubsetStudioStore.getState().toggle(pick('A', 'raw'))
    const out = await mountGrow().grow('downstream', 'all')
    expect(out.additions.map(a => a.urn)).toEqual(['C', 'D'])
  })

  it('a pick finer than the view\'s members asks the walk for its own first step', async () => {
    const getLineageBridges = vi.fn(async () => ({
      links: [{ source: 'A.col', target: 'C', hops: 2 }], incomplete: [], depthLimited: false, truncated: false,
    }))
    holder.current = { getLineageBridges }
    useSubsetStudioStore.getState().toggle(pick('A.col', 'raw'))
    const out = await mountGrow().grow('downstream', 'all')
    expect(out.additions.map(a => a.urn)).toEqual(['C', 'D'])
    const request = (getLineageBridges.mock.calls[0] as unknown[])[0] as { origins: string[]; direction: string; members: Array<{ urn: string }> }
    expect(request.origins).toEqual(['A.col'])
    expect(request.direction).toBe('downstream')
    expect(request.members.map(m => m.urn)).toContain('A.col')
  })

  it('beyond the view: a raw step is filed under the pick\'s grain and placed by the rules', async () => {
    const traceClosure = vi.fn(async () => ({
      nodes: [
        { urn: 'X', entityType: 'table', displayName: 'ext_orders', properties: {} },
        { urn: 'X.id', entityType: 'column', displayName: 'id', properties: {} },
        { urn: 'Dash', entityType: 'dashboard', displayName: 'Revenue board', properties: {} },
        { urn: 'D.c', entityType: 'column', displayName: 'c', properties: {} },
      ],
      edges: [],
      containmentEdges: [
        { id: 'c1', sourceUrn: 'X', targetUrn: 'X.id', edgeType: 'CONTAINS' },
        { id: 'c2', sourceUrn: 'D', targetUrn: 'D.c', edgeType: 'CONTAINS' },
      ],
      upstreamUrns: new Set<string>(),
      downstreamUrns: new Set(['X.id', 'Dash', 'D.c']),
      truncated: false,
    }))
    holder.current = { traceClosure }
    useSubsetStudioStore.getState().setReachBeyond(true)
    useSubsetStudioStore.getState().toggle(pick('D', 'marts'))
    const out = await mountGrow().grow('downstream', 'one')
    // D's own column is D itself; X.id files under X (a table, like D); a
    // dashboard lands where the rules put dashboards.
    expect(out.additions.map(a => [a.urn, a.layerId, a.origin])).toEqual([
      ['X', 'marts', 'outside'],
      ['Dash', 'marts', 'outside'],
    ])
    expect(traceClosure).toHaveBeenCalledWith(expect.objectContaining({ urn: 'D', direction: 'downstream', downstreamDepth: 1 }))
  })

  it('never offers what is already picked', async () => {
    useSubsetStudioStore.getState().add([pick('C', 'staging'), pick('A', 'raw')], 'x')
    const out = await mountGrow().grow('upstream', 'one')
    expect(out.additions.map(a => a.urn)).toEqual(['B'])
  })
})
