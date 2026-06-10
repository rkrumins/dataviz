import { describe, it, expect } from 'vitest'
import {
  isDrawableLineageType,
  deriveConnectableEdges,
  allowedChildTypeIds,
  canContain,
  connectableTargetTypes,
  retypeOptions,
  validateEntityDraft,
  isEdgeAuthorable,
  NON_DRAWABLE_EDGE_TYPES,
} from '../ontologyGuard'
import type { EntityTypeSchema, RelationshipTypeSchema, EntityFieldDefinition } from '@/types/schema'

const et = (id: string, canContainIds: string[], canBeContainedBy: string[] = [], fields: EntityFieldDefinition[] = []): EntityTypeSchema => ({
  id, name: id, pluralName: id, visual: {} as never, fields, behavior: {} as never,
  hierarchy: { level: 0, canContain: canContainIds, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})

const field = (id: string, required: boolean): EntityFieldDefinition => ({
  id, name: id, type: 'string', required, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0,
})

const rt = (
  id: string,
  sourceTypes: string[],
  targetTypes: string[],
  extra: Partial<RelationshipTypeSchema> = {},
): RelationshipTypeSchema => ({ id, name: id, sourceTypes, targetTypes, ...extra } as RelationshipTypeSchema)

// ── moved from services/__tests__/ontologyPreflightService.test.ts ──────────

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
    expect(produces?.reason).toContain('not a valid target')
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
})

// ── new guard functions ──────────────────────────────────────────────────────

describe('canContain', () => {
  const types = [et('domain', ['system']), et('system', ['dataset'], ['domain']), et('dataset', [], ['system'])]

  it('allows a child declared in the parent canContain list', () => {
    expect(canContain('domain', 'system', types, ['domain'], {})).toBe(true)
  })

  it('rejects a child the parent cannot contain', () => {
    expect(canContain('domain', 'dataset', types, ['domain'], {})).toBe(false)
  })

  it('checks root types when there is no parent', () => {
    expect(canContain(null, 'domain', types, ['domain'], {})).toBe(true)
    expect(canContain(null, 'dataset', types, ['domain'], {})).toBe(false)
  })
})

describe('connectableTargetTypes', () => {
  const allTypeIds = ['domain', 'system', 'dataJob', 'dataset']
  const rels = [
    rt('PRODUCES', ['dataJob'], ['dataset'], { isLineage: true }),
    rt('FLOWS_TO', ['dataset'], ['dataset'], { isLineage: true }),
    rt('CONSUMES', ['dataJob'], ['dataset'], { isLineage: true }),
    rt('AGGREGATED', [], [], { isLineage: true }),
    rt('CONTAINS', ['system'], ['dataset'], { isContainment: true }),
  ]

  it('returns the union of target types over edge types valid for the source', () => {
    expect([...connectableTargetTypes('dataJob', allTypeIds, rels, [])].sort()).toEqual(['dataset'])
  })

  it('returns empty when no lineage edge accepts the source type', () => {
    expect(connectableTargetTypes('domain', allTypeIds, rels, []).size).toBe(0)
  })

  it('expands unrestricted target lists to every entity type', () => {
    const open = [rt('LINKS', ['dataset'], [], { isLineage: true })]
    expect([...connectableTargetTypes('dataset', allTypeIds, open, [])].sort()).toEqual([...allTypeIds].sort())
  })

  it('never derives targets from AGGREGATED or containment types', () => {
    const only = [rt('AGGREGATED', [], [], { isLineage: true }), rt('CONTAINS', ['system'], ['dataset'], { isContainment: true })]
    expect(connectableTargetTypes('system', allTypeIds, only, []).size).toBe(0)
  })
})

describe('retypeOptions', () => {
  const rels = [
    rt('FLOWS_TO', ['dataset'], ['dataset'], { isLineage: true }),
    rt('DERIVED_FROM', ['dataset'], ['dataset'], { isLineage: true }),
    rt('PRODUCES', ['dataJob'], ['dataset'], { isLineage: true }),
  ]

  it('lists the endpoint-pair options with the current type marked', () => {
    const out = retypeOptions('FLOWS_TO', 'dataset', 'dataset', rels, [])
    expect(out.find((o) => o.edgeType === 'FLOWS_TO')?.isCurrent).toBe(true)
    expect(out.find((o) => o.edgeType === 'DERIVED_FROM')?.isCurrent).toBe(false)
  })

  it('keeps invalid-for-this-pair types visible but disallowed with a reason', () => {
    const produces = retypeOptions('FLOWS_TO', 'dataset', 'dataset', rels, []).find((o) => o.edgeType === 'PRODUCES')
    expect(produces?.allowed).toBe(false)
    expect(produces?.reason).toBeTruthy()
  })
})

describe('validateEntityDraft', () => {
  const types = [
    et('dataset', [], [], [field('owner', true), field('notes', false)]),
    et('domain', []),
  ]

  it('requires an entity type and a name', () => {
    const none = validateEntityDraft(null, '', {}, types)
    expect(none.ok).toBe(false)
    expect(none.errors.entityType).toBeTruthy()
    expect(none.errors.displayName).toBeTruthy()
  })

  it('rejects an entity type missing from the ontology', () => {
    const out = validateEntityDraft('ghostType', 'X', {}, types)
    expect(out.ok).toBe(false)
    expect(out.errors.entityType).toBeTruthy()
  })

  it('flags missing required fields but not optional ones', () => {
    const out = validateEntityDraft('dataset', 'Orders', {}, types)
    expect(out.ok).toBe(false)
    expect(out.errors.owner).toBeTruthy()
    expect(out.errors.notes).toBeUndefined()
  })

  it('passes when required fields are present and treats whitespace as empty', () => {
    expect(validateEntityDraft('dataset', 'Orders', { owner: 'data-eng' }, types).ok).toBe(true)
    expect(validateEntityDraft('dataset', 'Orders', { owner: '   ' }, types).ok).toBe(false)
  })

  it('treats name-like required fields as satisfied by the display name', () => {
    const withName = [et('dataset', [], [], [field('name', true)])]
    expect(validateEntityDraft('dataset', 'Orders', {}, withName).ok).toBe(true)
  })
})

describe('isEdgeAuthorable', () => {
  it('rejects aggregated edges with a reason', () => {
    const out = isEdgeAuthorable({ data: { isAggregated: true, edgeType: 'AGGREGATED' } }, [])
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/aggregat/i)
  })

  it('rejects containment edges by canvas type or by ontology membership', () => {
    expect(isEdgeAuthorable({ type: 'containment', data: { edgeType: 'CONTAINS' } }, []).ok).toBe(false)
    expect(isEdgeAuthorable({ data: { edgeType: 'contains' } }, ['CONTAINS']).ok).toBe(false)
  })

  it('accepts raw lineage edges', () => {
    expect(isEdgeAuthorable({ type: 'lineage', data: { edgeType: 'FLOWS_TO' } }, ['CONTAINS']).ok).toBe(true)
  })
})
