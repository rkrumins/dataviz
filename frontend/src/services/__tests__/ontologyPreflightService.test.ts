import { describe, it, expect } from 'vitest'
import { selectDrawableLineageEdges, NON_DRAWABLE_EDGE_TYPES } from '../ontologyPreflightService'
import type { AllowedEdgeOption } from '@/providers/GraphDataProvider'

const opt = (edgeType: string, allowed = true): AllowedEdgeOption => ({
  edgeType, label: edgeType, allowed, reason: allowed ? undefined : 'nope',
})

describe('selectDrawableLineageEdges', () => {
  const lineage = ['FLOWS_TO', 'CONSUMES', 'PRODUCES', 'AGGREGATED']

  it('keeps raw lineage types and drops the synthetic AGGREGATED type', () => {
    const out = selectDrawableLineageEdges(
      [opt('FLOWS_TO'), opt('CONSUMES'), opt('AGGREGATED')],
      lineage,
    )
    expect(out.map((o) => o.edgeType)).toEqual(['FLOWS_TO', 'CONSUMES'])
  })

  it('drops non-lineage types (containment / metadata) entirely', () => {
    const out = selectDrawableLineageEdges(
      [opt('FLOWS_TO'), opt('CONTAINS'), opt('TAGGED_WITH')],
      lineage,
    )
    expect(out.map((o) => o.edgeType)).toEqual(['FLOWS_TO'])
  })

  it('keeps disallowed lineage types so the picker can show them disabled with a reason', () => {
    const out = selectDrawableLineageEdges([opt('PRODUCES', false)], lineage)
    expect(out).toEqual([{ edgeType: 'PRODUCES', label: 'PRODUCES', allowed: false, reason: 'nope' }])
  })

  it('treats AGGREGATED as non-drawable', () => {
    expect(NON_DRAWABLE_EDGE_TYPES.has('AGGREGATED')).toBe(true)
  })
})
