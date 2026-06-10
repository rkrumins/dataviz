import { describe, it, expect } from 'vitest'
import {
  selectDrawableLineageEdges,
  deriveAllowedEdges,
  allowedChildTypeIds,
  NON_DRAWABLE_EDGE_TYPES,
} from '../ontologyPreflightService'
import type { AllowedEdgeOption } from '@/providers/GraphDataProvider'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

const opt = (edgeType: string, allowed = true): AllowedEdgeOption => ({
  edgeType, label: edgeType, allowed, reason: allowed ? undefined : 'nope',
})

const et = (id: string, canContain: string[], canBeContainedBy: string[] = []): EntityTypeSchema => ({
  id, name: id, pluralName: id, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level: 0, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})

const rt = (id: string, sourceTypes: string[], targetTypes: string[]): RelationshipTypeSchema => ({
  id, name: id, sourceTypes, targetTypes,
} as RelationshipTypeSchema)

describe('selectDrawableLineageEdges', () => {
  const lineage = ['FLOWS_TO', 'CONSUMES', 'PRODUCES', 'AGGREGATED']

  it('keeps raw lineage types and drops the synthetic AGGREGATED type', () => {
    const out = selectDrawableLineageEdges([opt('FLOWS_TO'), opt('CONSUMES'), opt('AGGREGATED')], lineage)
    expect(out.map((o) => o.edgeType)).toEqual(['FLOWS_TO', 'CONSUMES'])
  })

  it('drops non-lineage types (containment / metadata) entirely', () => {
    const out = selectDrawableLineageEdges([opt('FLOWS_TO'), opt('CONTAINS'), opt('TAGGED_WITH')], lineage)
    expect(out.map((o) => o.edgeType)).toEqual(['FLOWS_TO'])
  })

  it('treats AGGREGATED as non-drawable', () => {
    expect(NON_DRAWABLE_EDGE_TYPES.has('AGGREGATED')).toBe(true)
  })
})

describe('deriveAllowedEdges', () => {
  const rels = [
    rt('FLOWS_TO', ['dataset', 'dataJob'], ['dataset', 'dataJob']),
    rt('PRODUCES', ['dataJob'], ['dataset']),
    rt('AGGREGATED', [], []),
    rt('CONTAINS', ['system'], ['dataset']),
  ]
  const lineage = ['FLOWS_TO', 'PRODUCES', 'AGGREGATED']

  it('marks a valid source as allowed and an invalid one as disallowed with a reason', () => {
    const out = deriveAllowedEdges('dataset', rels, lineage, 'outgoing')
    const flows = out.find((o) => o.edgeType === 'FLOWS_TO')
    const produces = out.find((o) => o.edgeType === 'PRODUCES')
    expect(flows?.allowed).toBe(true)
    expect(produces?.allowed).toBe(false)
    expect(produces?.reason).toContain('dataJob')
  })

  it('excludes AGGREGATED and non-lineage CONTAINS', () => {
    const out = deriveAllowedEdges('dataset', rels, lineage, 'outgoing')
    expect(out.map((o) => o.edgeType).sort()).toEqual(['FLOWS_TO', 'PRODUCES'])
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
