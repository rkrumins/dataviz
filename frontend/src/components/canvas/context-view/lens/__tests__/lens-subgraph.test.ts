import { describe, expect, it } from 'vitest'
import {
  buildLensSubgraph,
  focusAncestorChain,
  projectLensEdges,
  visibleLensNodes,
} from '../lens-subgraph'

const n = (urn: string) => ({ urn })
const ce = (sourceUrn: string, targetUrn: string) => ({ sourceUrn, targetUrn })
const le = (sourceUrn: string, targetUrn: string, edgeType = 'FLOWS') => ({
  id: `${sourceUrn}->${targetUrn}:${edgeType}`, sourceUrn, targetUrn, edgeType,
})

describe('buildLensSubgraph — ported', () => {
  it('scopes children to closure participants only (first_name of 1000 columns)', () => {
    // t1 has 1000 columns but only c1 is on the focus's lineage, so the closure
    // contains only c1. The scoped child set must be exactly [c1] — expanding t1
    // can never reveal the other 999.
    const sg = buildLensSubgraph({
      focusUrn: 'c1',
      nodes: [n('t1'), n('c1')],
      lineageEdges: [],
      containmentEdges: [ce('t1', 'c1'), ce('t1', 'c999')], // c999 is NOT a participant
    })

    expect(sg.nodes.get('t1')!.children).toEqual(['c1'])
    expect(sg.nodes.has('c999')).toBe(false)
    expect(sg.nodes.get('t1')!.isLeaf).toBe(false)
  })
})

// d1 ⊃ o1 ⊃ a1 ; d2 ⊃ o2 ⊃ a2 ; the only hop is a1 -> a2. o1 also contains a
// non-participant column (c999) that is NOT in the closure.
const scenario = () => buildLensSubgraph({
  focusUrn: 'a1',
  nodes: [n('d1'), n('o1'), n('a1'), n('d2'), n('o2'), n('a2')],
  lineageEdges: [le('a1', 'a2')],
  containmentEdges: [
    ce('d1', 'o1'), ce('o1', 'a1'), ce('o1', 'c999'),   // c999 = non-participant
    ce('d2', 'o2'), ce('o2', 'a2'),
  ],
  downstreamUrns: new Set(['a2']),
})

describe('visibleLensNodes — ported', () => {
  it('shows nested pre-order: top-most roots, then a node\'s scoped children once expanded — never the world', () => {
    expect(visibleLensNodes(scenario(), new Set())).toEqual(['d1', 'd2'])

    const sg = scenario()
    const visible = visibleLensNodes(sg, new Set(['d1', 'o1']))
    expect(visible).toEqual(['d1', 'o1', 'a1', 'd2'])
    expect(visible).not.toContain('c999')
  })
})

describe('focusAncestorChain — ported', () => {
  it('returns the focus ancestors so the view can auto-expand down to it', () => {
    expect(focusAncestorChain(scenario())).toEqual(new Set(['o1', 'd1']))
  })
})

describe('buildLensSubgraph — ragged and recursive depths', () => {
  it('a self-nesting chain (Node ⊃ Node ⊃ Node) gets correct structural depth/isLeaf', () => {
    // Ontology-agnostic: the SAME type nests inside itself, with no named
    // levels to lean on — depth must come purely from the containment chain.
    const sg = buildLensSubgraph({
      focusUrn: 'n1',
      nodes: [n('n1'), n('n2'), n('n3')],
      lineageEdges: [],
      containmentEdges: [ce('n1', 'n2'), ce('n2', 'n3')],
    })
    expect(sg.roots).toEqual(['n1'])
    expect(sg.nodes.get('n1')!.depth).toBe(0)
    expect(sg.nodes.get('n2')!.depth).toBe(1)
    expect(sg.nodes.get('n3')!.depth).toBe(2)
    expect(sg.nodes.get('n1')!.isLeaf).toBe(false)
    expect(sg.nodes.get('n2')!.isLeaf).toBe(false)
    expect(sg.nodes.get('n3')!.isLeaf).toBe(true)
  })

  it('a ragged estate — branches bottoming out at different depths — normalizes correctly', () => {
    //   d1 ⊃ o1 ⊃ a1        (no optional level — bottoms out at depth 2)
    //   d2 ⊃ o2 ⊃ g2 ⊃ a2   (optional level present — bottoms out at depth 3)
    const sg = buildLensSubgraph({
      focusUrn: 'a1',
      nodes: [n('d1'), n('o1'), n('a1'), n('d2'), n('o2'), n('g2'), n('a2')],
      lineageEdges: [le('a1', 'a2')],
      containmentEdges: [
        ce('d1', 'o1'), ce('o1', 'a1'),
        ce('d2', 'o2'), ce('o2', 'g2'), ce('g2', 'a2'),
      ],
    })
    expect(new Set(sg.roots)).toEqual(new Set(['d1', 'd2']))
    expect(sg.nodes.get('a1')!.depth).toBe(2)
    expect(sg.nodes.get('a2')!.depth).toBe(3)
    expect(sg.nodes.get('a1')!.isLeaf).toBe(true)
    expect(sg.nodes.get('a2')!.isLeaf).toBe(true)
    expect(sg.nodes.get('g2')!.isLeaf).toBe(false)
    expect(sg.nodes.get('o1')!.isLeaf).toBe(false)
  })
})

describe('buildLensSubgraph — containment cycle', () => {
  it('a containment cycle terminates (guard prevents infinite recursion) with finite, bounded depths', () => {
    // x and y contain each other — no legitimate root. Nothing here is safe
    // to recurse without a guard: depthOf(x) -> depthOf(y) -> depthOf(x)
    // would loop forever. The guard's cycle-detection base case (`return 0`
    // for a node already on the current recursion stack) is what stops it;
    // the value actually cached for each node is that base case plus
    // whatever the unwinding chain had already added; neither is a
    // self-loop (those are dropped outright by `parent === child`), so
    // neither is 0 in the settled output — the guarantee under test is
    // termination with a small finite depth, not a specific number.
    const sg = buildLensSubgraph({
      focusUrn: 'x',
      nodes: [n('x'), n('y')],
      lineageEdges: [],
      containmentEdges: [ce('x', 'y'), ce('y', 'x')],
    })
    expect(sg.roots).toEqual([])   // the cycle has no entry point
    expect(sg.nodes.get('x')!.depth).toBeGreaterThanOrEqual(0)
    expect(sg.nodes.get('y')!.depth).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(sg.nodes.get('x')!.depth)).toBe(true)
    expect(Number.isFinite(sg.nodes.get('y')!.depth)).toBe(true)
  })
})

describe('buildLensSubgraph — defensive drop', () => {
  it('drops a lineage edge referencing an unknown urn, without throwing, everything else intact', () => {
    // Mid-merge, a response's seam edge can momentarily name an urn the
    // accumulation hasn't unioned in yet. That must never throw — it's
    // silently unreachable once the merge completes, so the honest thing
    // is to drop it and keep every other edge.
    expect(() => buildLensSubgraph({
      focusUrn: 'f',
      nodes: [n('f'), n('a')],
      lineageEdges: [le('f', 'a'), le('f', 'ghost')],
      containmentEdges: [],
    })).not.toThrow()

    const sg = buildLensSubgraph({
      focusUrn: 'f',
      nodes: [n('f'), n('a')],
      lineageEdges: [le('f', 'a'), le('f', 'ghost'), le('ghost', 'f')],
      containmentEdges: [],
    })
    expect(sg.lineageEdges.map(e => [e.sourceUrn, e.targetUrn])).toEqual([['f', 'a']])
  })
})

describe('buildLensSubgraph — hop distance (hopUp / hopDown)', () => {
  it('a lineage cycle: BFS terminates, both directions\' hops are correct on the cycle members', () => {
    // Downstream of F: A <-> B cycle. Upstream of F: C <-> D cycle. Each
    // mutual edge pair must not spin the BFS forever, and the min-distance
    // per direction must still land correctly on the cycle members.
    const sg = buildLensSubgraph({
      focusUrn: 'F',
      nodes: [n('F'), n('A'), n('B'), n('C'), n('D')],
      lineageEdges: [
        le('F', 'A'), le('A', 'B'), le('B', 'A'),
        le('C', 'F'), le('D', 'C'), le('C', 'D'),
      ],
      containmentEdges: [],
    })
    expect(sg.nodes.get('F')!.hopDown).toBe(0)
    expect(sg.nodes.get('A')!.hopDown).toBe(1)
    expect(sg.nodes.get('B')!.hopDown).toBe(2)
    expect(sg.nodes.get('F')!.hopUp).toBe(0)
    expect(sg.nodes.get('C')!.hopUp).toBe(1)
    expect(sg.nodes.get('D')!.hopUp).toBe(2)
    // Cycle members on the "wrong" side never got reached the other way.
    expect(sg.nodes.get('A')!.hopUp).toBeNull()
    expect(sg.nodes.get('C')!.hopDown).toBeNull()
  })

  it('diamond: a node reachable via two paths gets the min hop; up/down are independent', () => {
    // F -> A -> C and F -> B -> C (diamond below F); D -> F (above F).
    const sg = buildLensSubgraph({
      focusUrn: 'F',
      nodes: [n('F'), n('A'), n('B'), n('C'), n('D')],
      lineageEdges: [le('F', 'A'), le('A', 'C'), le('F', 'B'), le('B', 'C'), le('D', 'F')],
      containmentEdges: [],
    })
    expect(sg.nodes.get('C')!.hopDown).toBe(2)
    expect(sg.nodes.get('C')!.hopUp).toBeNull()          // hopDown 2 ONLY
    expect(sg.nodes.get('D')!.hopUp).toBe(1)
    expect(sg.nodes.get('D')!.hopDown).toBeNull()         // hopUp 1 ONLY
    // F is the seed: it carries BOTH hops (the pivot the diamond hangs off).
    expect(sg.nodes.get('F')!.hopUp).toBe(0)
    expect(sg.nodes.get('F')!.hopDown).toBe(0)
  })

  it('container-focus hop 0: a container focus seeds hop 0 from its in-model descendants, both directions', () => {
    // DOM contains t1 and t2 (both in-model). x feeds INTO t1 from outside
    // DOM. t1/t2/DOM must all be hop 0 (not t1 at hop 1) — the container
    // itself has no lineage edges; only its descendants do.
    const sg = buildLensSubgraph({
      focusUrn: 'DOM',
      nodes: [n('DOM'), n('t1'), n('t2'), n('x')],
      lineageEdges: [le('x', 't1')],
      containmentEdges: [ce('DOM', 't1'), ce('DOM', 't2')],
    })
    expect(sg.nodes.get('DOM')!.hopUp).toBe(0)
    expect(sg.nodes.get('DOM')!.hopDown).toBe(0)
    expect(sg.nodes.get('t1')!.hopUp).toBe(0)
    expect(sg.nodes.get('t1')!.hopDown).toBe(0)
    expect(sg.nodes.get('t2')!.hopUp).toBe(0)
    expect(sg.nodes.get('t2')!.hopDown).toBe(0)
    expect(sg.nodes.get('x')!.hopUp).toBe(1)
    expect(sg.nodes.get('x')!.hopDown).toBeNull()
  })
})

describe('buildLensSubgraph — degreeUp / degreeDown', () => {
  it('parallel edges (distinct ids, same pair) both count', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'A',
      nodes: [n('A'), n('B')],
      lineageEdges: [
        { id: 'e1', sourceUrn: 'A', targetUrn: 'B', edgeType: 'FLOWS' },
        { id: 'e2', sourceUrn: 'A', targetUrn: 'B', edgeType: 'FLOWS' },
      ],
      containmentEdges: [],
    })
    expect(sg.nodes.get('A')!.degreeDown).toBe(2)
    expect(sg.nodes.get('B')!.degreeUp).toBe(2)
    expect(sg.nodes.get('A')!.degreeUp).toBe(0)
    expect(sg.nodes.get('B')!.degreeDown).toBe(0)
  })

  it('degrees split by direction correctly on a node with both an in- and out-edge', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'X',
      nodes: [n('W'), n('X'), n('Y')],
      lineageEdges: [le('W', 'X'), le('X', 'Y')],
      containmentEdges: [],
    })
    expect(sg.nodes.get('X')!.degreeUp).toBe(1)
    expect(sg.nodes.get('X')!.degreeDown).toBe(1)
    expect(sg.nodes.get('W')!.degreeDown).toBe(1)
    expect(sg.nodes.get('W')!.degreeUp).toBe(0)
    expect(sg.nodes.get('Y')!.degreeUp).toBe(1)
    expect(sg.nodes.get('Y')!.degreeDown).toBe(0)
  })
})

describe('buildLensSubgraph — frontier stamping', () => {
  it('stamps frontier entries onto the right nodes, passing totalCount/nextCursor through untouched', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'a',
      nodes: [n('a'), n('b'), n('c')],
      lineageEdges: [],
      containmentEdges: [],
      frontierUp: [
        { urn: 'a', totalCount: 5, nextCursor: 'e:10' },
        { urn: 'zzz-unknown', totalCount: 1, nextCursor: null },   // not a member — ignored
      ],
      frontierDown: [
        { urn: 'b', totalCount: null, nextCursor: null },
        { urn: 'c', totalCount: 3, nextCursor: 'e:0' },
      ],
    })
    expect(sg.nodes.get('a')!.frontierUp).toEqual({ urn: 'a', totalCount: 5, nextCursor: 'e:10' })
    expect(sg.nodes.get('b')!.frontierDown).toEqual({ urn: 'b', totalCount: null, nextCursor: null })
    expect(sg.nodes.get('c')!.frontierDown).toEqual({ urn: 'c', totalCount: 3, nextCursor: 'e:0' })
    // Nothing stamped where there's no entry for that node/direction.
    expect(sg.nodes.get('a')!.frontierDown).toBeNull()
    expect(sg.nodes.get('b')!.frontierUp).toBeNull()
    expect(sg.nodes.get('c')!.frontierUp).toBeNull()
  })

  it('an unknown urn in the frontier lists is silently ignored, never thrown', () => {
    expect(() => buildLensSubgraph({
      focusUrn: 'a',
      nodes: [n('a')],
      lineageEdges: [],
      containmentEdges: [],
      frontierUp: [{ urn: 'ghost', totalCount: 1, nextCursor: null }],
    })).not.toThrow()
  })
})

describe('buildLensSubgraph — seedTruncated passthrough', () => {
  it('passes seedTruncated through, defaulting to false', () => {
    const base = { focusUrn: 'a', nodes: [n('a')], lineageEdges: [], containmentEdges: [] }
    expect(buildLensSubgraph(base).seedTruncated).toBe(false)
    expect(buildLensSubgraph({ ...base, seedTruncated: true }).seedTruncated).toBe(true)
  })
})

describe('projectLensEdges — directional projection', () => {
  it('A->B and B->A project as two distinct DIRECTIONAL bundles, each a visible single-hop leaf edge', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'A',
      nodes: [n('A'), n('B')],
      lineageEdges: [le('A', 'B'), le('B', 'A')],
      containmentEdges: [],
    })
    const population = new Set(['A', 'B'])
    const visible = new Set(['A', 'B'])
    const result = projectLensEdges(sg, population, visible)
    expect(result).toHaveLength(2)
    const byKey = new Map(result.map(e => [`${e.sourceUrn}>${e.targetUrn}`, e]))
    expect(byKey.get('A>B')).toEqual({ sourceUrn: 'A', targetUrn: 'B', weight: 1, isLeafEdge: true, edgeTypeNorm: 'FLOWS' })
    expect(byKey.get('B>A')).toEqual({ sourceUrn: 'B', targetUrn: 'A', weight: 1, isLeafEdge: true, edgeTypeNorm: 'FLOWS' })
  })

  it('collapses hops from two children of a collapsed container into one bundle, weight 2, container as endpoint', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'a1',
      nodes: [n('D1'), n('a1'), n('a1b'), n('D2')],
      lineageEdges: [le('a1', 'D2'), le('a1b', 'D2')],
      containmentEdges: [ce('D1', 'a1'), ce('D1', 'a1b')],
    })
    const population = new Set(['D1', 'a1', 'a1b', 'D2'])
    const visible = new Set(['D1', 'D2'])   // a1 / a1b collapsed under D1
    expect(projectLensEdges(sg, population, visible)).toEqual([
      { sourceUrn: 'D1', targetUrn: 'D2', weight: 2, isLeafEdge: false, edgeTypeNorm: 'FLOWS' },
    ])
  })

  it('hides a hop internal to a single collapsed container — never drawn as a self-loop', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'x1',
      nodes: [n('D1'), n('x1'), n('x2')],
      lineageEdges: [le('x1', 'x2')],
      containmentEdges: [ce('D1', 'x1'), ce('D1', 'x2')],
    })
    const population = new Set(['D1', 'x1', 'x2'])
    const visible = new Set(['D1'])
    expect(projectLensEdges(sg, population, visible)).toEqual([])
  })

  it('a bundle bundling more than one edge type reports edgeTypeNorm as empty', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'X',
      nodes: [n('X'), n('Y')],
      lineageEdges: [le('X', 'Y', 'FLOWS'), le('X', 'Y', 'COPIES')],
      containmentEdges: [],
    })
    const population = new Set(['X', 'Y'])
    const visible = new Set(['X', 'Y'])
    expect(projectLensEdges(sg, population, visible)).toEqual([
      { sourceUrn: 'X', targetUrn: 'Y', weight: 2, isLeafEdge: false, edgeTypeNorm: '' },
    ])
  })

  it('drops a hop with an endpoint outside the population — a "+N" pill\'s job, not this one', () => {
    const sg = buildLensSubgraph({
      focusUrn: 'A',
      nodes: [n('A'), n('Z')],
      lineageEdges: [le('A', 'Z')],
      containmentEdges: [],
    })
    const population = new Set(['A'])   // Z is known to the model but outside the loaded population
    const visible = new Set(['A', 'Z'])
    expect(projectLensEdges(sg, population, visible)).toEqual([])
  })
})
