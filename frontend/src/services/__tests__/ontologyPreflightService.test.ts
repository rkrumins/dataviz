import { describe, it, expect } from 'vitest'
import {
  isDrawableLineageType,
  deriveConnectableEdges,
  allowedChildTypeIds,
  NON_DRAWABLE_EDGE_TYPES,
} from '../ontologyPreflightService'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

const et = (id: string, canContain: string[], canBeContainedBy: string[] = []): EntityTypeSchema => ({
  id, name: id, pluralName: id, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level: 0, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
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
