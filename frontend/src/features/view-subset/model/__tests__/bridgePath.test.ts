/**
 * buildBridgePathModel — the hidden steps behind a virtual hop, at the grain
 * the view speaks.
 */
import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode, LineageBridgePathResult } from '@/providers/GraphDataProvider'

import { buildBridgePathModel } from '../bridgePath'
import { memberSetKey } from '../memberSetKey'

const node = (urn: string, entityType: string, displayName = urn): GraphNode =>
  ({ urn, entityType, displayName, properties: {} })
const edge = (sourceUrn: string, targetUrn: string): GraphEdge =>
  ({ id: `${sourceUrn}->${targetUrn}`, sourceUrn, targetUrn, edgeType: 'TRANSFORMS' })

function result(overrides: Partial<LineageBridgePathResult>): LineageBridgePathResult {
  return {
    source: 'A', target: 'C', hops: 2,
    hiddenUrns: [], endpointUrns: [], nodes: [], edges: [], ancestorChains: {},
    truncated: false,
    ...overrides,
  }
}

describe('buildBridgePathModel', () => {
  it('files column steps under their table, the grain of the two members', () => {
    // A.x -> B.y -> B.z -> C.w : three raw hops, one hidden table.
    const model = buildBridgePathModel(result({
      hops: 3,
      hiddenUrns: ['B.y', 'B.z'],
      endpointUrns: ['A.x', 'C.w'],
      edges: [edge('A.x', 'B.y'), edge('B.y', 'B.z'), edge('B.z', 'C.w')],
      nodes: [
        node('A', 'table', 'orders'), node('C', 'table', 'revenue'),
        node('B', 'table', 'stg_orders'), node('WH', 'schema', 'staging'),
        node('A.x', 'column'), node('C.w', 'column'), node('B.y', 'column'), node('B.z', 'column'),
      ],
      ancestorChains: { 'A.x': ['A'], 'C.w': ['C'], 'B.y': ['B', 'WH'], 'B.z': ['B', 'WH'], B: ['WH'] },
    }))
    expect(model.hops).toBe(3)
    // Two raw steps inside one hidden table read as one step at table grain.
    expect(model.levels).toEqual([
      [{ urn: 'B', name: 'stg_orders', entityType: 'table', context: ['staging'], nodes: 2 }],
    ])
    expect(model.trail).toEqual(['A', 'B', 'C'])
  })

  it('lays equal-length routes side by side at their distance', () => {
    const model = buildBridgePathModel(result({
      hops: 3,
      hiddenUrns: ['P', 'Q', 'R'],
      edges: [edge('A', 'P'), edge('A', 'Q'), edge('P', 'R'), edge('Q', 'R'), edge('R', 'C')],
      nodes: ['A', 'C', 'P', 'Q', 'R'].map(u => node(u, 'table')),
    }))
    expect(model.levels.map(l => l.map(s => s.urn))).toEqual([['P', 'Q'], ['R']])
    expect(model.trail).toEqual(['A', 'P', 'R', 'C'])
  })

  it('keeps a step that has no container at the members grain as itself', () => {
    const model = buildBridgePathModel(result({
      hiddenUrns: ['job'],
      edges: [edge('A', 'job'), edge('job', 'C')],
      nodes: [node('A', 'table'), node('C', 'table'), node('job', 'process', 'nightly load')],
    }))
    expect(model.levels).toEqual([[{ urn: 'job', name: 'nightly load', entityType: 'process', context: [], nodes: 1 }]])
  })

  it('counts the raw steps a shown step stands for', () => {
    const model = buildBridgePathModel(result({
      hiddenUrns: ['B.a', 'B.b'],
      edges: [edge('A', 'B.a'), edge('A', 'B.b'), edge('B.a', 'C'), edge('B.b', 'C')],
      nodes: [node('A', 'table'), node('C', 'table'), node('B', 'table', 'stg')],
      ancestorChains: { 'B.a': ['B'], 'B.b': ['B'] },
    }))
    expect(model.levels).toEqual([[expect.objectContaining({ urn: 'B', nodes: 2 })]])
  })

  it('names a step it could not load by the end of its urn', () => {
    const model = buildBridgePathModel(result({
      hiddenUrns: ['urn:li:dataset:warehouse.stg_orders'],
      edges: [edge('A', 'urn:li:dataset:warehouse.stg_orders'), edge('urn:li:dataset:warehouse.stg_orders', 'C')],
    }))
    expect(model.levels[0][0].name).toBe('stg_orders')
  })

  it('says there is no route when the graph no longer connects the two', () => {
    expect(buildBridgePathModel(result({ hops: null }))).toEqual({ hops: null, levels: [], trail: [] })
  })

  it('a direct link has no hidden steps and a two-stop trail', () => {
    const model = buildBridgePathModel(result({ hops: 1, edges: [edge('A', 'C')] }))
    expect(model.levels).toEqual([])
    expect(model.trail).toEqual(['A', 'C'])
  })
})

describe('memberSetKey', () => {
  it('is the same for the same members in any order', () => {
    expect(memberSetKey([{ urn: 'a' }, { urn: 'b', inheritsChildren: false }]))
      .toBe(memberSetKey([{ urn: 'b', inheritsChildren: false }, { urn: 'a', inheritsChildren: true }]))
  })

  it('changes when a member stops taking in what sits beneath it', () => {
    expect(memberSetKey([{ urn: 'a' }])).not.toBe(memberSetKey([{ urn: 'a', inheritsChildren: false }]))
  })

  it('changes when the set does', () => {
    expect(memberSetKey([{ urn: 'a' }])).not.toBe(memberSetKey([{ urn: 'a' }, { urn: 'b' }]))
  })
})
