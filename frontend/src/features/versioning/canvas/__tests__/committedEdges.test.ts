/**
 * A relationship saved on the draft — an import's included — is found on the canvas by its id or,
 * failing that, by its two ends (an imported edge's id is not the canvas's), and haloed in the
 * colour of what the draft did to it.
 */
import { describe, expect, it } from 'vitest'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'
import { COMMITTED_EDGE_COLOR, committedEdgeLookup } from '../committedEdges'

const origin = { source: 'branch' as const, branchId: 'b' }
const edge = (over: Partial<GraphChange>): GraphChange => ({ entityId: 'gv-e1', kind: 'edge', status: 'added', label: 'FEEDS', origin, ...over })

describe('committedEdgeLookup', () => {
  it('finds a line by id, or else by its ends', () => {
    const look = committedEdgeLookup(buildChangeSet([
      edge({ entityId: 'e-known', status: 'modified' }),
      edge({ entityId: 'gv-import-7', sourceUrn: 'urn:a', targetUrn: 'urn:b' }),
    ]))
    expect(look.colorOf({ id: 'e-known', source: 'x', target: 'y' })).toBe(COMMITTED_EDGE_COLOR.modified)
    expect(look.colorOf({ id: 'canvas-edge-1', source: 'urn:a', target: 'urn:b' })).toBe(COMMITTED_EDGE_COLOR.added)
    expect(look.colorOf({ id: 'canvas-edge-2', source: 'urn:b', target: 'urn:a' })).toBeUndefined()
  })

  it('marks nothing without a change set, or with entity changes only', () => {
    expect(committedEdgeLookup(null).colorOf({ id: 'e', source: 'a', target: 'b' })).toBeUndefined()
    const nodesOnly = buildChangeSet([{ entityId: 'n', kind: 'node', status: 'added', label: 'n', origin }])
    expect(committedEdgeLookup(nodesOnly).colorOf({ id: 'n', source: 'a', target: 'b' })).toBeUndefined()
  })
})
