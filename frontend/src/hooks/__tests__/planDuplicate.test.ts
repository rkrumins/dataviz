/**
 * planDuplicate is the pure staging plan for "Duplicate": recreate an entity
 * AND its full descendant subtree as fresh copies (clean ids, `duplicatedFrom`
 * provenance, internal-only lineage). Pure + deterministic — no store mocking.
 */
import { describe, it, expect } from 'vitest'
import { planDuplicate, topmostOf, type DuplicateSourceNode, type DuplicateLineageEdgeInput } from '../planDuplicate'

const src = (overrides: Partial<DuplicateSourceNode> & { urn: string }): DuplicateSourceNode => ({
  entityType: 'dataset',
  displayName: overrides.urn,
  ...overrides,
})

describe('planDuplicate', () => {
  it('gives the root step "{name} (Copy)" while descendants keep their names', () => {
    const childMap = new Map([['root', ['child']]])
    const nodeData = new Map([
      ['root', src({ urn: 'root', displayName: 'Root Entity' })],
      ['child', src({ urn: 'child', displayName: 'Child Entity' })],
    ])

    const plan = planDuplicate('root', childMap, nodeData, [])

    const rootStep = plan.nodes.find((n) => n.originalId === 'root')!
    const childStep = plan.nodes.find((n) => n.originalId === 'child')!
    expect(rootStep.displayName).toBe('Root Entity (Copy)')
    expect(childStep.displayName).toBe('Child Entity')
  })

  it('threads parent references through a 3-level tree in parent-before-child order', () => {
    const childMap = new Map([
      ['root', ['mid']],
      ['mid', ['leaf']],
    ])
    const nodeData = new Map([
      ['root', src({ urn: 'root' })],
      ['mid', src({ urn: 'mid' })],
      ['leaf', src({ urn: 'leaf' })],
    ])

    const plan = planDuplicate('root', childMap, nodeData, [])

    expect(plan.nodes.map((n) => n.originalId)).toEqual(['root', 'mid', 'leaf'])
    expect(plan.nodes[0].parentOriginalId).toBeNull()
    expect(plan.nodes[1].parentOriginalId).toBe('root')
    expect(plan.nodes[2].parentOriginalId).toBe('mid')
  })

  it('branches a node with 2 children — both point at the same parent step', () => {
    const childMap = new Map([['root', ['a', 'b']]])
    const nodeData = new Map([
      ['root', src({ urn: 'root' })],
      ['a', src({ urn: 'a' })],
      ['b', src({ urn: 'b' })],
    ])

    const plan = planDuplicate('root', childMap, nodeData, [])

    expect(plan.nodes).toHaveLength(3)
    const a = plan.nodes.find((n) => n.originalId === 'a')!
    const b = plan.nodes.find((n) => n.originalId === 'b')!
    expect(a.parentOriginalId).toBe('root')
    expect(b.parentOriginalId).toBe('root')
  })

  it('stamps every node step with properties.duplicatedFrom = that node\'s own original urn', () => {
    const childMap = new Map([['root', ['child']]])
    const nodeData = new Map([
      ['root', src({ urn: 'urn:real:root', properties: { color: 'blue' } })],
      ['child', src({ urn: 'urn:real:child' })],
    ])

    const plan = planDuplicate('root', childMap, nodeData, [])

    const rootStep = plan.nodes.find((n) => n.originalId === 'root')!
    const childStep = plan.nodes.find((n) => n.originalId === 'child')!
    expect(rootStep.properties.duplicatedFrom).toBe('urn:real:root')
    expect(rootStep.properties.color).toBe('blue') // original properties preserved alongside provenance
    expect(childStep.properties.duplicatedFrom).toBe('urn:real:child')
  })

  it('folds each node\'s description into properties.description so it survives the copy', () => {
    const childMap = new Map([['root', ['child']]])
    const nodeData = new Map([
      ['root', src({ urn: 'root', description: 'Root description', properties: { color: 'blue' } })],
      ['child', src({ urn: 'child' })], // no description
    ])

    const plan = planDuplicate('root', childMap, nodeData, [])

    const rootStep = plan.nodes.find((n) => n.originalId === 'root')!
    const childStep = plan.nodes.find((n) => n.originalId === 'child')!
    expect(rootStep.properties.description).toBe('Root description')
    expect(rootStep.properties.color).toBe('blue') // other properties still preserved
    expect(childStep.properties).not.toHaveProperty('description') // absent when the source had none
  })

  it('plans an edge step for a lineage edge with both endpoints inside the subtree', () => {
    const childMap = new Map([['root', ['a', 'b']]])
    const nodeData = new Map([
      ['root', src({ urn: 'root' })],
      ['a', src({ urn: 'a' })],
      ['b', src({ urn: 'b' })],
    ])
    const lineageEdges: DuplicateLineageEdgeInput[] = [
      { source: 'a', target: 'b', edgeType: 'FLOWS_TO' },
    ]

    const plan = planDuplicate('root', childMap, nodeData, lineageEdges)

    expect(plan.edges).toEqual([{ sourceOriginalId: 'a', targetOriginalId: 'b', edgeType: 'FLOWS_TO' }])
  })

  it('drops a cross-boundary lineage edge (one endpoint outside the subtree)', () => {
    const childMap = new Map([['root', ['a']]])
    const nodeData = new Map([
      ['root', src({ urn: 'root' })],
      ['a', src({ urn: 'a' })],
    ])
    // 'outside' has no entry in childMap/nodeData — it's not part of the subtree.
    const lineageEdges: DuplicateLineageEdgeInput[] = [
      { source: 'a', target: 'outside', edgeType: 'FLOWS_TO' },
    ]

    const plan = planDuplicate('root', childMap, nodeData, lineageEdges)

    expect(plan.edges).toEqual([])
  })

  it('carries the containment edge type from each node\'s own original parent edge', () => {
    const childMap = new Map([['root', ['child']]])
    const nodeData = new Map([
      ['root', src({ urn: 'root', containmentEdgeType: 'PART_OF' })],
      ['child', src({ urn: 'child', containmentEdgeType: 'CONTAINS' })],
    ])

    const plan = planDuplicate('root', childMap, nodeData, [])

    expect(plan.nodes.find((n) => n.originalId === 'root')!.containmentEdgeType).toBe('PART_OF')
    expect(plan.nodes.find((n) => n.originalId === 'child')!.containmentEdgeType).toBe('CONTAINS')
  })

  // ── Options: what a duplicate copies besides the entity ───────────────

  const family = () => {
    const childMap = new Map([['root', ['a', 'b']]])
    const nodeData = new Map([
      ['root', src({ urn: 'root', displayName: 'Orders' })],
      ['a', src({ urn: 'a' })],
      ['b', src({ urn: 'b' })],
    ])
    const lineageEdges: DuplicateLineageEdgeInput[] = [
      { source: 'a', target: 'b', edgeType: 'FLOWS_TO' },        // inside
      { source: 'upstream', target: 'a', edgeType: 'FLOWS_TO' }, // into the copy
      { source: 'b', target: 'report', edgeType: 'FEEDS' },      // out of the copy
      { source: 'other', target: 'elsewhere', edgeType: 'FEEDS' }, // not touching it
    ]
    return { childMap, nodeData, lineageEdges }
  }

  it('the entity alone: no children, and only the edges touching it', () => {
    const { childMap, nodeData, lineageEdges } = family()
    const plan = planDuplicate('root', childMap, nodeData, lineageEdges, { includeDescendants: false, incoming: true, outgoing: true })
    expect(plan.nodes.map((n) => n.originalId)).toEqual(['root'])
    expect(plan.edges).toEqual([])
  })

  it('incoming: the original source feeds the copy too — that end stays the original', () => {
    const { childMap, nodeData, lineageEdges } = family()
    const plan = planDuplicate('root', childMap, nodeData, lineageEdges, { incoming: true })
    expect(plan.edges).toContainEqual({ sourceOriginalId: 'upstream', targetOriginalId: 'a', edgeType: 'FLOWS_TO', keeps: 'source' })
    expect(plan.edges.find((e) => e.keeps === 'target')).toBeUndefined()
  })

  it('outgoing: the copy feeds what the original feeds — that end stays the original', () => {
    const { childMap, nodeData, lineageEdges } = family()
    const plan = planDuplicate('root', childMap, nodeData, lineageEdges, { outgoing: true })
    expect(plan.edges).toContainEqual({ sourceOriginalId: 'b', targetOriginalId: 'report', edgeType: 'FEEDS', keeps: 'target' })
    expect(plan.edges.find((e) => e.keeps === 'source')).toBeUndefined()
  })

  it('never plans an edge that touches nothing copied, and can leave out the inside ones', () => {
    const { childMap, nodeData, lineageEdges } = family()
    const plan = planDuplicate('root', childMap, nodeData, lineageEdges, { internal: false, incoming: true, outgoing: true })
    expect(plan.edges.map((e) => e.keeps)).toEqual(['source', 'target'])
  })

  it('plans an edge seen twice (on the canvas and from the server) once', () => {
    const { childMap, nodeData, lineageEdges } = family()
    const plan = planDuplicate('root', childMap, nodeData, [...lineageEdges, { source: 'a', target: 'b', edgeType: 'flows_to' }])
    expect(plan.edges.filter((e) => e.sourceOriginalId === 'a' && e.targetOriginalId === 'b')).toHaveLength(1)
  })

  it('copies the source system, never the qualified name', () => {
    const childMap = new Map<string, string[]>()
    const nodeData = new Map([['root', src({ urn: 'root', sourceSystem: 'snowflake' })]])
    const plan = planDuplicate('root', childMap, nodeData, [])
    expect(plan.nodes[0].sourceSystem).toBe('snowflake')
    expect(plan.nodes[0]).not.toHaveProperty('qualifiedName')
  })
})

describe('topmostOf', () => {
  const parent: Record<string, string> = { child: 'root', grandchild: 'child', sibling: 'root' }
  const parentOf = (id: string) => parent[id]

  it('drops a selected entity that sits inside another selected one', () => {
    expect(topmostOf(['grandchild', 'root', 'other'], parentOf)).toEqual(['root', 'other'])
  })

  it('keeps siblings and unrelated entities, in selection order', () => {
    expect(topmostOf(['sibling', 'child'], parentOf)).toEqual(['sibling', 'child'])
  })

  it('survives a containment loop', () => {
    const loop: Record<string, string> = { a: 'b', b: 'a' }
    expect(topmostOf(['a'], (id) => loop[id])).toEqual(['a'])
  })
})
