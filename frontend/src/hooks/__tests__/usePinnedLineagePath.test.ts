import { describe, it, expect } from 'vitest'
import { computePinnedPath, type PathEdge } from '../usePinnedLineagePath'

const e = (source: string, target: string, isContainment = false): PathEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  isContainment,
})

const noParents = new Map<string, string>()

describe('computePinnedPath', () => {
  it('is inactive with no focus', () => {
    const r = computePinnedPath({
      edges: [e('A', 'B')],
      focusUrn: null,
      pinnedUrns: ['B'],
      containmentParent: noParents,
    })
    expect(r.active).toBe(false)
    expect(r.pathNodeUrns.size).toBe(0)
    expect(r.pathEdgeIds.size).toBe(0)
  })

  it('is inactive with no pins', () => {
    const r = computePinnedPath({
      edges: [e('A', 'B')],
      focusUrn: 'A',
      pinnedUrns: [],
      containmentParent: noParents,
    })
    expect(r.active).toBe(false)
  })

  it('keeps the whole chain on a linear path', () => {
    const edges = [e('A', 'B'), e('B', 'C'), e('C', 'D')]
    const r = computePinnedPath({
      edges,
      focusUrn: 'A',
      pinnedUrns: ['D'],
      containmentParent: noParents,
    })
    expect(r.active).toBe(true)
    expect([...r.pathNodeUrns].sort()).toEqual(['A', 'B', 'C', 'D'])
    expect([...r.pathEdgeIds].sort()).toEqual(['A->B', 'B->C', 'C->D'])
  })

  it('keeps every route (all-paths) and drops off-path branches', () => {
    // A→B→D and A→C→D are both routes to D. A→E→F is unrelated.
    const edges = [
      e('A', 'B'),
      e('B', 'D'),
      e('A', 'C'),
      e('C', 'D'),
      e('A', 'E'),
      e('E', 'F'),
    ]
    const r = computePinnedPath({
      edges,
      focusUrn: 'A',
      pinnedUrns: ['D'],
      containmentParent: noParents,
    })
    expect([...r.pathNodeUrns].sort()).toEqual(['A', 'B', 'C', 'D'])
    expect(r.pathNodeUrns.has('E')).toBe(false)
    expect(r.pathNodeUrns.has('F')).toBe(false)
    expect([...r.pathEdgeIds].sort()).toEqual(['A->B', 'A->C', 'B->D', 'C->D'])
  })

  it('unions the routes for multiple pins', () => {
    const edges = [e('A', 'B'), e('B', 'D'), e('A', 'E'), e('E', 'F')]
    const r = computePinnedPath({
      edges,
      focusUrn: 'A',
      pinnedUrns: ['D', 'F'],
      containmentParent: noParents,
    })
    expect([...r.pathNodeUrns].sort()).toEqual(['A', 'B', 'D', 'E', 'F'])
    expect([...r.pathEdgeIds].sort()).toEqual(['A->B', 'A->E', 'B->D', 'E->F'])
  })

  it('still isolates the reachable pin when another pin is unreachable', () => {
    const edges = [e('A', 'B'), e('B', 'D')]
    const r = computePinnedPath({
      edges,
      focusUrn: 'A',
      pinnedUrns: ['D', 'ORPHAN'],
      containmentParent: noParents,
    })
    expect(r.pathNodeUrns.has('A')).toBe(true)
    expect(r.pathNodeUrns.has('D')).toBe(true)
    expect([...r.pathEdgeIds].sort()).toEqual(['A->B', 'B->D'])
  })

  it('isolates correctly when the pin is upstream of the focus', () => {
    // Lineage flows C→B→A; trace focus is A, pin is its upstream root C.
    const edges = [e('C', 'B'), e('B', 'A')]
    const r = computePinnedPath({
      edges,
      focusUrn: 'A',
      pinnedUrns: ['C'],
      containmentParent: noParents,
    })
    expect([...r.pathNodeUrns].sort()).toEqual(['A', 'B', 'C'])
    expect([...r.pathEdgeIds].sort()).toEqual(['B->A', 'C->B'])
  })

  it('never treats containment edges as lineage path edges', () => {
    const edges = [
      e('A', 'B'),
      e('B', 'D'),
      e('ROOT', 'A', true), // containment
      e('ROOT', 'B', true), // containment
    ]
    const r = computePinnedPath({
      edges,
      focusUrn: 'A',
      pinnedUrns: ['D'],
      containmentParent: noParents,
    })
    expect(r.pathEdgeIds.has('ROOT->A')).toBe(false)
    expect(r.pathEdgeIds.has('ROOT->B')).toBe(false)
    expect([...r.pathEdgeIds].sort()).toEqual(['A->B', 'B->D'])
  })

  it('flags pins with no lineage route to the focus as unreachable', () => {
    // A→B→D forms one connected lineage; ORPHAN has no edge at all and X→Y
    // is a separate component disconnected from focus A.
    const edges = [e('A', 'B'), e('B', 'D'), e('X', 'Y')]
    const r = computePinnedPath({
      edges,
      focusUrn: 'A',
      pinnedUrns: ['D', 'ORPHAN', 'Y'],
      containmentParent: noParents,
    })
    expect(r.unreachablePinUrns.has('D')).toBe(false)
    expect([...r.unreachablePinUrns].sort()).toEqual(['ORPHAN', 'Y'])
    // Unreachable pins still appear in pathNodeUrns so the UI can keep them
    // visible while warning the user.
    expect(r.pathNodeUrns.has('ORPHAN')).toBe(true)
    expect(r.pathNodeUrns.has('Y')).toBe(true)
  })

  it('retains containment ancestors for layout without putting them on the path', () => {
    const containmentParent = new Map<string, string>([
      ['A', 'ROOT'],
      ['B', 'ROOT'],
      ['D', 'ROOT'],
    ])
    const r = computePinnedPath({
      edges: [e('A', 'B'), e('B', 'D')],
      focusUrn: 'A',
      pinnedUrns: ['D'],
      containmentParent,
    })
    expect(r.pathNodeUrns.has('ROOT')).toBe(false)
    expect(r.keepForLayoutUrns.has('ROOT')).toBe(true)
  })

  // Direction filter — two pins, one upstream and one downstream of the
  // focus. With 'both', both routes survive; with 'downstream' only the
  // downstream route, and the upstream pin becomes unreachable; with
  // 'upstream' the mirror happens.
  describe('direction filter', () => {
    const setup = () => ({
      // U → A is upstream of focus A; A → D is downstream.
      edges: [e('U', 'A'), e('A', 'D')],
      focusUrn: 'A' as string | null,
      pinnedUrns: ['U', 'D'],
      containmentParent: noParents,
    })

    it("'downstream' drops the upstream pin's contribution", () => {
      const r = computePinnedPath({ ...setup(), direction: 'downstream' })
      // Downstream-only path: focus A → pinned D. Upstream pin U is forced
      // into the node set so the chip stays visible, but it's flagged
      // unreachable in this direction and contributes no edges.
      expect(r.pathNodeUrns.has('A')).toBe(true)
      expect(r.pathNodeUrns.has('D')).toBe(true)
      expect(r.pathEdgeIds.has('A->D')).toBe(true)
      expect(r.pathEdgeIds.has('U->A')).toBe(false)
      expect(r.unreachablePinUrns.has('U')).toBe(true)
      expect(r.unreachablePinUrns.has('D')).toBe(false)
    })

    it("'upstream' drops the downstream pin's contribution", () => {
      const r = computePinnedPath({ ...setup(), direction: 'upstream' })
      expect(r.pathNodeUrns.has('A')).toBe(true)
      expect(r.pathNodeUrns.has('U')).toBe(true)
      expect(r.pathEdgeIds.has('U->A')).toBe(true)
      expect(r.pathEdgeIds.has('A->D')).toBe(false)
      expect(r.unreachablePinUrns.has('D')).toBe(true)
      expect(r.unreachablePinUrns.has('U')).toBe(false)
    })

    it("'both' (default) keeps both orientations and marks neither unreachable", () => {
      const r = computePinnedPath({ ...setup(), direction: 'both' })
      expect(r.pathEdgeIds.has('U->A')).toBe(true)
      expect(r.pathEdgeIds.has('A->D')).toBe(true)
      expect(r.unreachablePinUrns.size).toBe(0)
    })
  })
})
