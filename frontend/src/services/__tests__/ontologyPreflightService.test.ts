import { describe, it, expect } from 'vitest'
import {
  isDrawableLineageType,
  deriveConnectableEdges,
  deriveContainmentEdges,
  isContainmentRelType,
  allowedChildTypeIds,
  builderAllowedChildTypeIds,
  isClosedToNesting,
  containmentChains,
  NON_DRAWABLE_EDGE_TYPES,
  endpointOk,
  setHasId,
  validateDrawnEdge,
  connectedEdgeTypes,
  typesValidForNode,
  planRetype,
} from '../ontologyPreflightService'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import type { RetypeContext, RetypeNode } from '../ontologyPreflightService'

const et = (id: string, canContain: string[], canBeContainedBy: string[] = [], level = 0): EntityTypeSchema => ({
  id, name: id, pluralName: id, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})

const rt = (
  id: string,
  sourceTypes: string[],
  targetTypes: string[],
  extra: Partial<RelationshipTypeSchema> = {},
): RelationshipTypeSchema => ({ id, name: id, sourceTypes, targetTypes, ...extra } as RelationshipTypeSchema)

describe('isDrawableLineageType', () => {
  it('excludes the synthetic AGGREGATED type', () => {
    expect(isDrawableLineageType(rt('AGGREGATED', [], [], { isLineage: true }), [])).toBe(false)
    expect(NON_DRAWABLE_EDGE_TYPES.has('AGGREGATED')).toBe(true)
  })

  it('excludes containment types — by flag or by containmentEdgeTypes membership', () => {
    expect(isDrawableLineageType(rt('CONTAINS', [], [], { isContainment: true }), [])).toBe(false)
    expect(isDrawableLineageType(rt('BELONGS_TO', [], []), ['BELONGS_TO'])).toBe(false)
  })

  it('excludes explicitly non-lineage metadata types', () => {
    expect(isDrawableLineageType(rt('TAGGED_WITH', [], [], { isLineage: false }), [])).toBe(false)
  })

  it('includes lineage types and defaults unknown non-containment types to drawable', () => {
    expect(isDrawableLineageType(rt('FLOWS_TO', [], [], { isLineage: true }), [])).toBe(true)
    expect(isDrawableLineageType(rt('CUSTOM_REL', [], []), [])).toBe(true)
  })
})

describe('deriveConnectableEdges', () => {
  const rels = [
    rt('PRODUCES', ['dataJob'], ['dataset'], { isLineage: true }),
    rt('FLOWS_TO', ['dataset'], ['dataset'], { isLineage: true }),
    rt('AGGREGATED', [], [], { isLineage: true }),
    rt('CONTAINS', ['system'], ['dataset'], { isContainment: true }),
  ]

  it('returns lineage edges even when containmentEdgeTypes/lineageEdgeTypes are empty (regression)', () => {
    // The old bug required membership in lineageEdgeTypes (often empty) → nothing.
    const out = deriveConnectableEdges('dataset', 'dataset', rels, [])
    expect(out.map((o) => o.edgeType).sort()).toEqual(['FLOWS_TO', 'PRODUCES'])
  })

  it('allows an edge only when BOTH endpoints satisfy the ontology', () => {
    const out = deriveConnectableEdges('dataJob', 'dataset', rels, [])
    expect(out.find((o) => o.edgeType === 'PRODUCES')?.allowed).toBe(true)
  })

  it('disallows with a target reason when the source is valid but the target is not', () => {
    const out = deriveConnectableEdges('dataJob', 'dataJob', rels, [])
    const produces = out.find((o) => o.edgeType === 'PRODUCES')
    expect(produces?.allowed).toBe(false)
    expect(produces?.reason).toContain("can't be the target")
  })

  it('humanizes reasons with entity-type names and the edge label', () => {
    const named = [
      { ...et('attribute', []), name: 'Attribute' },
      { ...et('column', []), name: 'Column' },
      { ...et('dataJob', []), name: 'Data Job' },
      { ...et('dataset', []), name: 'Dataset' },
    ]
    const flows = [rt('flows_to', ['column', 'dataJob', 'dataset'], ['dataset'], { isLineage: true, name: 'Flows To' })]
    const out = deriveConnectableEdges('attribute', 'dataset', flows, [], named)
    expect(out[0].allowed).toBe(false)
    expect(out[0].reason).toBe("An Attribute can't be the source of 'Flows To'. Works from: Column, Data Job, Dataset.")
  })

  it('resolves the display name case-insensitively when the offending endpoint type is graph-cased', () => {
    // 'attribute' is ontology-cased in `named`; a discovered graph node typed 'ATTRIBUTE' must
    // still resolve to the friendly name 'Attribute' in the reason, not fall back to the raw id.
    const named = [{ ...et('attribute', []), name: 'Attribute' }, { ...et('column', []), name: 'Column' }]
    const flows = [rt('flows_to', ['column'], ['dataset'], { isLineage: true, name: 'Flows To' })]
    const out = deriveConnectableEdges('ATTRIBUTE', 'dataset', flows, [], named)
    expect(out[0].reason).toContain('An Attribute')
  })

  it('never offers AGGREGATED or containment types', () => {
    const out = deriveConnectableEdges('dataset', 'dataset', rels, [])
    expect(out.find((o) => o.edgeType === 'AGGREGATED')).toBeUndefined()
    expect(out.find((o) => o.edgeType === 'CONTAINS')).toBeUndefined()
  })

  it('treats empty / wildcard endpoint lists as unrestricted', () => {
    const wild = [rt('LINKS', [], [], { isLineage: true }), rt('STAR', ['*'], ['*'], { isLineage: true })]
    const out = deriveConnectableEdges('anything', 'whatever', wild, [])
    expect(out.every((o) => o.allowed)).toBe(true)
    expect(out.map((o) => o.edgeType).sort()).toEqual(['LINKS', 'STAR'])
  })

  it('matches endpoint types against a discovered graph\'s differently-cased ids (case-insensitive)', () => {
    // rels' FLOWS_TO is defined with lowercase endpoint types ['dataset']; a discovered
    // graph node typed 'DATASET' must still satisfy it.
    const out = deriveConnectableEdges('DATASET', 'DATASET', rels, [])
    expect(out.find((o) => o.edgeType === 'FLOWS_TO')?.allowed).toBe(true)
  })
})

describe('isContainmentRelType', () => {
  it('uses the explicit flag when present', () => {
    expect(isContainmentRelType(rt('CONTAINS', [], [], { isContainment: true }), [])).toBe(true)
    expect(isContainmentRelType(rt('FLOWS_TO', [], [], { isContainment: false }), ['FLOWS_TO'])).toBe(false)
  })
  it('falls back to containmentEdgeTypes membership (case-insensitive)', () => {
    expect(isContainmentRelType(rt('part_of', [], []), ['PART_OF'])).toBe(true)
    expect(isContainmentRelType(rt('UNRELATED', [], []), ['CONTAINS'])).toBe(false)
  })
})

describe('deriveContainmentEdges', () => {
  const rels = [
    rt('CONTAINS', ['system'], ['dataset'], { isContainment: true }),  // parent→child (system contains dataset)
    rt('PART_OF', ['dataset'], ['system'], { isContainment: true }),   // authored child→parent
    rt('FLOWS_TO', ['dataset'], ['dataset'], { isLineage: true }),     // not containment
  ]

  it('offers only containment types, never lineage', () => {
    const out = deriveContainmentEdges('system', 'dataset', rels, [])
    expect(out.find((o) => o.edgeType === 'FLOWS_TO')).toBeUndefined()
  })

  it('allows CONTAINS in the parent→child (forward) orientation', () => {
    const out = deriveContainmentEdges('system', 'dataset', rels, [])
    expect(out.find((o) => o.edgeType === 'CONTAINS')?.allowed).toBe(true)
  })

  it('rejects a child→parent predicate (forward-only): the edge is stored parent→child', () => {
    // parent=system, child=dataset; PART_OF is authored source=dataset(child), target=system(parent),
    // so the parent 'system' is not an allowed source → not offered for nesting.
    const out = deriveContainmentEdges('system', 'dataset', rels, [])
    expect(out.find((o) => o.edgeType === 'PART_OF')?.allowed).toBe(false)
  })

  it('disallows when the forward orientation fails, with a reason', () => {
    const out = deriveContainmentEdges('system', 'system', rels, [])
    const contains = out.find((o) => o.edgeType === 'CONTAINS')
    expect(contains?.allowed).toBe(false)
    expect(contains?.reason).toBeTruthy()
  })

  it('treats membership-only containment types (no flag) as containment', () => {
    const out = deriveContainmentEdges('a', 'b', [rt('OWNS', [], [])], ['OWNS'])
    expect(out.map((o) => o.edgeType)).toEqual(['OWNS'])
    expect(out[0].allowed).toBe(true) // wildcard endpoints
  })

  it('matches the forward parent/child pair against a discovered graph\'s differently-cased ids', () => {
    // CONTAINS is defined parent→child as ['system']→['dataset']; a discovered graph
    // using lowercase/uppercase-mismatched ids must still resolve the same forward pair.
    const out = deriveContainmentEdges('SYSTEM', 'DATASET', rels, [])
    expect(out.find((o) => o.edgeType === 'CONTAINS')?.allowed).toBe(true)
  })
})

describe('allowedChildTypeIds', () => {
  const types = [et('domain', ['system']), et('system', ['dataset'], ['domain']), et('dataset', [], ['system'])]

  it('returns declared roots when there is no parent', () => {
    expect([...allowedChildTypeIds(null, types, ['domain'], {})]).toEqual(['domain'])
  })

  it('falls back to uncontainable types as roots when rootEntityTypes is empty', () => {
    expect([...allowedChildTypeIds(null, types, [], {})]).toEqual(['domain'])
  })

  it('returns the parent type can-contain set', () => {
    expect([...allowedChildTypeIds('system', types, ['domain'], {})]).toEqual(['dataset'])
  })

  it('treats empty canContain as unrestricted', () => {
    expect([...allowedChildTypeIds('dataset', types, ['domain'], {})].sort()).toEqual(['dataset', 'domain', 'system'])
  })

  it('resolves a differently-cased parentType against the ontology-cased entityTypes (e.g. discovered "DATASET" vs fixture "dataset")', () => {
    expect([...allowedChildTypeIds('DATASET', types, ['domain'], {})].sort()).toEqual(['dataset', 'domain', 'system'])
  })

  it('resolves a differently-cased parentType against hierarchyMap keys, returning canContain in its stored (ontology) casing', () => {
    const hierarchyMap = { SYSTEM: { canContain: ['dataset'] } }
    expect([...allowedChildTypeIds('system', [], [], hierarchyMap)]).toEqual(['dataset'])
  })
})

describe('setHasId', () => {
  it('matches an exact id', () => {
    expect(setHasId(new Set(['dataset', 'system']), 'dataset')).toBe(true)
  })

  it('matches a differently-cased id (discovered graph child type vs ontology-cased set)', () => {
    expect(setHasId(new Set(['dataset', 'system']), 'DATASET')).toBe(true)
  })

  it('returns false when no member matches, case-insensitively', () => {
    expect(setHasId(new Set(['dataset', 'system']), 'column')).toBe(false)
  })
})

describe('builderAllowedChildTypeIds', () => {
  const types = [et('domain', ['system', 'dataset']), et('system', ['dataset'], ['domain']), et('dataset', [], ['system'])]
  const rels = [rt('CONTAINS', ['domain', 'system'], ['dataset'], { isContainment: true })]

  it('offers the declared roots when there is no parent', () => {
    expect([...builderAllowedChildTypeIds(null, types, ['domain'], {}, rels, [])]).toEqual(['domain'])
  })

  it('offers nothing under a leaf, even with a wildcard containment edge (empty canContain = closed, not unrestricted)', () => {
    const wildContains = rt('CONTAINS', [], [], { isContainment: true })
    expect(builderAllowedChildTypeIds('dataset', types, ['domain'], {}, [wildContains], []).size).toBe(0)
  })

  it('intersects the parent canContain set with types nestable via at least one allowed containment edge', () => {
    // domain canContain system+dataset, but CONTAINS only targets dataset → system is dropped.
    expect([...builderAllowedChildTypeIds('domain', types, ['domain'], {}, rels, [])]).toEqual(['dataset'])
  })

  it('resolves a differently-cased parentType (e.g. discovered "DOMAIN" vs fixture "domain")', () => {
    expect([...builderAllowedChildTypeIds('DOMAIN', types, ['domain'], {}, rels, [])]).toEqual(['dataset'])
  })
})

describe('isClosedToNesting', () => {
  it('is closed when canContain is empty in both the schema and hierarchyMap', () => {
    expect(isClosedToNesting('dataset', [et('dataset', [])], {})).toBe(true)
  })

  it('is not closed when the schema declares children', () => {
    expect(isClosedToNesting('domain', [et('domain', ['system'])], {})).toBe(false)
  })

  it('resolves a differently-cased parentType against the ontology-cased entityTypes', () => {
    expect(isClosedToNesting('DATASET', [et('dataset', [])], {})).toBe(true)
    expect(isClosedToNesting('DOMAIN', [et('domain', ['system'])], {})).toBe(false)
  })
})

describe('containmentChains', () => {
  // domain L0 -> {dataPlatform, system} L1 -> container L2 -> dataset L3 -> column L4,
  // with container self-nesting (container -> container).
  const types = [
    et('domain', ['dataPlatform', 'system'], [], 0),
    et('dataPlatform', ['container'], ['domain'], 1),
    et('system', [], ['domain'], 1),
    et('container', ['container', 'dataset'], ['dataPlatform', 'container'], 2),
    et('dataset', ['column'], ['container'], 3),
    et('column', [], ['dataset'], 4),
  ]

  it('derives maximal chains from the roots, folding the self-loop and terminating on empty canContain', () => {
    const chains = containmentChains(types, ['domain'])
    expect(chains).toEqual([
      ['domain', 'dataPlatform', 'container', 'dataset', 'column'],
      ['domain', 'system'],
    ])
    // The prefix must not appear as a separate maximal chain.
    expect(chains).not.toContainEqual(['domain', 'dataPlatform', 'container', 'dataset'])
  })

  it('terminates the container->container self-loop without repeating a type in one path', () => {
    const chains = containmentChains(types, ['domain'])
    const withContainer = chains.find((c) => c.includes('container'))!
    expect(withContainer.filter((id) => id === 'container')).toHaveLength(1)
  })

  it('startType scopes chains to start at that type', () => {
    expect(containmentChains(types, ['domain'], { startType: 'container' })).toEqual([
      ['container', 'dataset', 'column'],
    ])
  })

  it('maxLength caps chain length and still emits the truncated path', () => {
    expect(containmentChains(types, ['domain'], { maxLength: 3 })).toEqual([
      ['domain', 'dataPlatform', 'container'],
      ['domain', 'system'],
    ])
  })

  it('falls back to empty-canBeContainedBy types as roots when rootEntityTypes is empty', () => {
    expect(containmentChains(types, [])).toEqual(containmentChains(types, ['domain']))
  })
})

describe('endpointOk', () => {
  it('passes wildcard/empty/`*` and exact matches; fails a non-member', () => {
    expect(endpointOk('domain', undefined)).toBe(true)
    expect(endpointOk('domain', [])).toBe(true)
    expect(endpointOk('domain', ['*'])).toBe(true)
    expect(endpointOk('domain', ['domain', 'system'])).toBe(true)
    expect(endpointOk('column', ['domain', 'system'])).toBe(false)
  })

  it('matches membership case-insensitively (discovered graph ids vs ontology-cased allowedTypes, and vice versa)', () => {
    expect(endpointOk('DOMAIN', ['domain', 'system'])).toBe(true)
    expect(endpointOk('domain', ['DOMAIN', 'SYSTEM'])).toBe(true)
    expect(endpointOk('Attribute', ['attribute'])).toBe(true)
    expect(endpointOk('COLUMN', ['domain', 'system'])).toBe(false)
  })
})

describe('validateDrawnEdge', () => {
  const rels = [
    rt('FLOWS_TO', ['dataset'], ['dataset'], { isLineage: true }),
    rt('CONTAINS', ['domain'], ['dataset'], { isContainment: true }),
  ]
  const base = { relationshipTypes: rels, containmentEdgeTypes: ['CONTAINS'] }

  it('rejects a containment type from free-draw', () => {
    const v = validateDrawnEdge({ ...base, sourceType: 'domain', targetType: 'dataset', edgeType: 'CONTAINS' })
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/Move to|child/i)
  })

  it('rejects an unknown relationship type', () => {
    expect(validateDrawnEdge({ ...base, sourceType: 'dataset', targetType: 'dataset', edgeType: 'NOPE' }).allowed).toBe(false)
  })

  it('rejects an endpoint-type violation', () => {
    const v = validateDrawnEdge({ ...base, sourceType: 'column', targetType: 'dataset', edgeType: 'FLOWS_TO' })
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/source/i)
  })

  it('allows a valid lineage edge', () => {
    expect(validateDrawnEdge({ ...base, sourceType: 'dataset', targetType: 'dataset', edgeType: 'FLOWS_TO' }).allowed).toBe(true)
  })

  it('rejects a duplicate (same source+target+type already present)', () => {
    const existingEdges = [{ source: 'a', target: 'b', data: { edgeType: 'flows_to' } }]
    const v = validateDrawnEdge({
      ...base, sourceType: 'dataset', targetType: 'dataset', edgeType: 'FLOWS_TO',
      existingEdges, sourceId: 'a', targetId: 'b',
    })
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/already/i)
  })

  it('allows the same type between a DIFFERENT pair', () => {
    const existingEdges = [{ source: 'a', target: 'b', data: { edgeType: 'FLOWS_TO' } }]
    const v = validateDrawnEdge({
      ...base, sourceType: 'dataset', targetType: 'dataset', edgeType: 'FLOWS_TO',
      existingEdges, sourceId: 'a', targetId: 'c',
    })
    expect(v.allowed).toBe(true)
  })
})

describe('connectedEdgeTypes', () => {
  it('returns the UPPERCASE set of types already connecting source→target', () => {
    const edges = [
      { source: 'a', target: 'b', data: { edgeType: 'flows_to' } },
      { source: 'a', target: 'b', data: { relationship: 'derives_from' } },
      { source: 'a', target: 'c', data: { edgeType: 'other' } },
    ]
    const s = connectedEdgeTypes(edges, 'a', 'b')
    expect(s.has('FLOWS_TO')).toBe(true)
    expect(s.has('DERIVES_FROM')).toBe(true)
    expect(s.has('OTHER')).toBe(false)
  })
})

describe('typesValidForNode', () => {
  // domain(L0) contains dataPlatform,system; dataPlatform(L1) contains container;
  // container(L2, canContain container,dataset); dataset(L3, canContain column); column(L4 leaf)
  const types = [
    et('domain', ['dataPlatform', 'system'], [], 0),
    et('dataPlatform', ['container'], ['domain'], 1),
    et('system', [], ['domain'], 1),
    et('container', ['container', 'dataset'], ['dataPlatform', 'container'], 2),
    et('dataset', ['column'], ['container'], 3),
    et('column', [], ['dataset'], 4),
  ]
  // A single permissive containment edge covering every parent/child pair the tests below
  // exercise, so `containmentAllowed` (relationship-driven) matches the hierarchy comment above.
  const rels = [
    rt(
      'CONTAINS',
      ['domain', 'dataPlatform', 'container', 'dataset'],
      ['dataPlatform', 'system', 'container', 'dataset', 'column'],
      { isContainment: true },
    ),
  ]

  function makeCtx(opts: {
    parentType: string | null
    children?: RetypeNode[]
    edges?: { edgeType: string; role: 'source' | 'target'; otherType: string }[]
  }): RetypeContext {
    return {
      entityTypes: types,
      relationshipTypes: rels,
      containmentEdgeTypes: ['CONTAINS'],
      parentTypeOf: () => opts.parentType,
      childrenOf: () => opts.children ?? [],
      incidentLineageEdges: () => opts.edges ?? [],
    }
  }

  it('typesValidForNode: a dataset under dataPlatform can become container (valid child + can hold its column)', () => {
    const ctx = makeCtx({ parentType: 'dataPlatform', children: [{ id: 'c', urn: 'c', name: 'id', type: 'column' }] })
    const node = { id: 'n', urn: 'n', name: 'orders', type: 'dataset' }
    expect(typesValidForNode(node, ctx)).toContain('container')
  })
  it('typesValidForNode: excludes types that cannot contain an existing child', () => {
    const ctx = makeCtx({ parentType: 'dataPlatform', children: [{ id: 'c', urn: 'c', name: 'id', type: 'column' }] })
    const node = { id: 'n', urn: 'n', name: 'orders', type: 'dataset' }
    expect(typesValidForNode(node, ctx)).not.toContain('column') // column can't contain column
  })
  it('typesValidForNode: excludes types invalid under the parent', () => {
    const ctx = makeCtx({ parentType: 'dataPlatform', children: [] })
    const node = { id: 'n', urn: 'n', name: 'x', type: 'dataset' }
    expect(typesValidForNode(node, ctx)).not.toContain('domain') // domain can't be under dataPlatform
  })
  it('typesValidForNode: a leaf with no children offers all types the parent can contain', () => {
    const ctx = makeCtx({ parentType: 'dataset', children: [] })
    const node = { id: 'n', urn: 'n', name: 'col', type: 'column' }
    const res = typesValidForNode(node, ctx)
    expect(res).toContain('column') // column is a valid child of dataset
  })
})

describe('planRetype', () => {
  // database(L0, canContain table) -> table(L1, canContain column) -> column(L2, leaf)
  // dataPlatform(L0, canContain container) -> container(L1, canContain container,dataset) -> dataset(L2, canContain column)
  // group(L0, canContain group only) -> attribute(L1, leaf; NOT directly containable by group)
  const types = [
    et('database', ['table'], [], 0),
    et('table', ['column'], ['database'], 1),
    et('column', [], ['table', 'dataset'], 2),
    et('dataPlatform', ['container'], [], 0),
    et('container', ['container', 'dataset'], ['dataPlatform', 'container'], 1),
    et('dataset', ['column'], ['container'], 2),
    et('group', ['group'], [], 0),
    et('attribute', [], ['group'], 1),
  ]
  const rels = [
    rt('CONTAINS_TABLE', ['database'], ['table'], { isContainment: true }),
    rt('CONTAINS_COLUMN_IN_TABLE', ['table'], ['column'], { isContainment: true }),
    rt('CONTAINS_IN_CONTAINER', ['dataPlatform', 'container'], ['container', 'dataset'], { isContainment: true }),
    rt('CONTAINS_COLUMN_IN_DATASET', ['dataset'], ['column'], { isContainment: true }),
    rt('CONTAINS_GROUP', ['group'], ['group'], { isContainment: true }),
  ]

  // `childrenOf` returns NESTED children (unlike `makeCtx`'s flat single-level list above),
  // so the cascade can walk more than one level deep. `parent` only needs to resolve for
  // nodes that are themselves keys in `nodes` — planRetype never calls `parentTypeOf`.
  function makeTreeCtx(
    nodes: Record<string, { type: string; parent: string | null; children: string[] }>,
    entityTypes: EntityTypeSchema[] = types,
    relationshipTypes: RelationshipTypeSchema[] = rels,
  ): RetypeContext {
    return {
      entityTypes,
      relationshipTypes,
      containmentEdgeTypes: [],
      parentTypeOf: (id) => {
        const parentId = nodes[id]?.parent ?? null
        return parentId ? (nodes[parentId]?.type ?? null) : null
      },
      childrenOf: (id) =>
        (nodes[id]?.children ?? []).map((childId) => ({
          id: childId,
          urn: childId,
          name: childId,
          type: nodes[childId].type,
        })),
      incidentLineageEdges: () => [],
    }
  }

  it('planRetype: uniform up-shift — table->database re-levels columns->tables', () => {
    // fixture where database canContain table; table canContain column; column leaf
    const ctx = makeTreeCtx({ 'db':{type:'table',parent:null,children:['t']}, 't':{type:'column',parent:'db',children:[]} })
    const plan = planRetype({ id:'db', urn:'db', name:'DB', type:'table' }, 'database', ctx)
    expect(plan.ok).toBe(true)
    expect(plan.changes.find(c=>c.nodeId==='db')).toMatchObject({ toType:'database', editable:false })
    expect(plan.changes.find(c=>c.nodeId==='t')).toMatchObject({ toType:'table', editable:true })
  })
  it('planRetype: prunes descendants that stay valid', () => {
    const ctx = makeTreeCtx({ 'r':{type:'container',parent:'dataPlatform',children:['d']}, 'd':{type:'dataset',parent:'r',children:[]} })
    // container->container is still a valid parent of dataset, so no cascade
    const plan = planRetype({ id:'r', urn:'r', name:'R', type:'container' }, 'container', ctx)
    expect(plan.changes.map(c=>c.nodeId)).toEqual(['r'])
  })
  it('planRetype: recursive Group->Group cascade terminates', () => {
    const ctx = makeTreeCtx({ 'g':{type:'attribute',parent:'group',children:['g2']}, 'g2':{type:'attribute',parent:'g',children:[]} })
    const plan = planRetype({ id:'g', urn:'g', name:'G', type:'attribute' }, 'group', ctx)
    expect(plan.ok).toBe(true) // group canContain group, so g2->group is valid; terminates
  })
  it('planRetype: unresolvable child becomes a conflict, ok=false', () => {
    const ctx = makeTreeCtx({ 'r':{type:'dataset',parent:'dataPlatform',children:['x']}, 'x':{type:'column',parent:'r',children:[]} })
    // retype r->column: column can't contain anything -> x has no valid re-level
    const plan = planRetype({ id:'r', urn:'r', name:'R', type:'dataset' }, 'column', ctx)
    expect(plan.ok).toBe(false)
    expect(plan.conflicts.map(c=>c.nodeId)).toContain('x')
  })

  it('planRetype: finds a deep multi-level re-level instead of a false conflict (recursive feasibility)', () => {
    // Reviewer's repro: Y canContain {P,Q}; P canContain nothing; Q canContain only Z.
    // root(M)->child(M)->gc(G), retype root->Y. Valid solution: child->Q, gc->Z. The old
    // shallow childrenStillFit gate excluded Q (Q can't DIRECTLY hold gc's current type G),
    // reporting a false conflict; recursive feasibility must find the assignment.
    const t = [et('Y', ['P', 'Q']), et('P', []), et('Q', ['Z']), et('Z', [])]
    const r = [
      rt('Y_HOLDS', ['Y'], ['P', 'Q'], { isContainment: true }),
      rt('Q_HOLDS', ['Q'], ['Z'], { isContainment: true }),
    ]
    const ctx = makeTreeCtx(
      {
        'root': { type: 'M', parent: null, children: ['child'] },
        'child': { type: 'M', parent: 'root', children: ['gc'] },
        'gc': { type: 'G', parent: 'child', children: [] },
      },
      t,
      r,
    )
    const plan = planRetype({ id: 'root', urn: 'root', name: 'root', type: 'M' }, 'Y', ctx)
    expect(plan.ok).toBe(true)
    expect(plan.changes.find((c) => c.nodeId === 'root')).toMatchObject({ toType: 'Y', editable: false })
    expect(plan.changes.find((c) => c.nodeId === 'child')).toMatchObject({ toType: 'Q', editable: true })
    expect(plan.changes.find((c) => c.nodeId === 'gc')).toMatchObject({ toType: 'Z', editable: true })
  })

  it('planRetype: reports a genuine deep conflict when no assignment resolves the subtree', () => {
    // RootT canContain {Mid}; Mid canContain nothing. root->child->gc, retype root->RootT.
    // child must become Mid (its only option), but then gc has nowhere to live -> real conflict.
    const t = [et('RootT', ['Mid']), et('Mid', [])]
    const r = [rt('ROOTT_HOLDS', ['RootT'], ['Mid'], { isContainment: true })]
    const ctx = makeTreeCtx(
      {
        'root': { type: 'orig', parent: null, children: ['child'] },
        'child': { type: 'CX', parent: 'root', children: ['gc'] },
        'gc': { type: 'GX', parent: 'child', children: [] },
      },
      t,
      r,
    )
    const plan = planRetype({ id: 'root', urn: 'root', name: 'root', type: 'orig' }, 'RootT', ctx)
    expect(plan.ok).toBe(false)
    expect(plan.conflicts.map((c) => c.nodeId)).toContain('gc')
    expect(plan.changes).toEqual([])
  })

  it('planRetype: backtracks past a candidate that dead-ends deeper to one that resolves', () => {
    // Base canContain {Opt1,Opt2}; Opt1 canContain {Mid1}; Opt2 canContain {Mid2};
    // Mid1 canContain nothing; Mid2 canContain {Leaf3}. Tree R->N->K->L, retype R->Base.
    // Opt1 sorts first for N but dead-ends TWO levels deeper (L can't nest under Mid1);
    // true backtracking must fall back to Opt2 -> K->Mid2 -> L->Leaf3.
    const t = [
      et('Base', ['Opt1', 'Opt2']),
      et('Opt1', ['Mid1']),
      et('Opt2', ['Mid2']),
      et('Mid1', []),
      et('Mid2', ['Leaf3']),
      et('Leaf3', []),
    ]
    const r = [
      rt('BASE_HOLDS', ['Base'], ['Opt1', 'Opt2'], { isContainment: true }),
      rt('OPT1_HOLDS', ['Opt1'], ['Mid1'], { isContainment: true }),
      rt('OPT2_HOLDS', ['Opt2'], ['Mid2'], { isContainment: true }),
      rt('MID2_HOLDS', ['Mid2'], ['Leaf3'], { isContainment: true }),
    ]
    const ctx = makeTreeCtx(
      {
        'R': { type: 'orig', parent: null, children: ['N'] },
        'N': { type: 'NX', parent: 'R', children: ['K'] },
        'K': { type: 'KX', parent: 'N', children: ['L'] },
        'L': { type: 'LX', parent: 'K', children: [] },
      },
      t,
      r,
    )
    const plan = planRetype({ id: 'R', urn: 'R', name: 'R', type: 'orig' }, 'Base', ctx)
    expect(plan.ok).toBe(true)
    expect(plan.changes.find((c) => c.nodeId === 'N')).toMatchObject({ toType: 'Opt2' })
    expect(plan.changes.find((c) => c.nodeId === 'K')).toMatchObject({ toType: 'Mid2' })
    expect(plan.changes.find((c) => c.nodeId === 'L')).toMatchObject({ toType: 'Leaf3' })
  })
})
