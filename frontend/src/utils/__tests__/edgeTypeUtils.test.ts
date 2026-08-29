/**
 * `getEdgeTypeDefinition` — the presentational copy layer wins over the stored
 * ontology wording (2026-08-30).
 *
 * `AGGREGATED` is a system type the aggregation worker writes; its ontology
 * name ("Aggregated") and description are seeded per data source and add-only,
 * so they cannot be reworded at the source without a backfill. The word is
 * owned here instead — but only the WORD: colour, stroke and animation still
 * come from whatever the schema (or the default) says.
 */
import { describe, it, expect } from 'vitest'
import type { RelationshipTypeSchema } from '@/types/schema'
import { getEdgeTypeDefinition } from '../edgeTypeUtils'

const rel = (over: Partial<RelationshipTypeSchema>): RelationshipTypeSchema => ({
  id: 'AGGREGATED',
  name: 'Aggregated',
  description: 'A synthetic aggregated lineage edge computed from column-level lineage.',
  sourceTypes: [],
  targetTypes: [],
  visual: {
    strokeColor: '#22c55e',
    strokeWidth: 2,
    strokeStyle: 'solid',
    animated: true,
    animationSpeed: 'normal',
    arrowType: 'arrow',
    curveType: 'bezier',
  },
  bidirectional: false,
  showLabel: true,
  ...over,
})

describe('getEdgeTypeDefinition — AGGREGATED copy override', () => {
  it('overrides the schema name and description, keeping the schema visuals', () => {
    const def = getEdgeTypeDefinition('AGGREGATED', [rel({})], [])
    expect(def.label).toBe('Combined flow')
    expect(def.description).toBe('Many detailed flows between two items, shown as one connection.')
    expect(def.color).toBe('#22c55e')
    expect(def.strokeStyle).toBe('solid')
    expect(def.animated).toBe(true)
  })

  it('applies to the default branch too, when no schema entry exists', () => {
    const def = getEdgeTypeDefinition('AGGREGATED', [], [])
    expect(def.label).toBe('Combined flow')
    expect(def.description).toBe('Many detailed flows between two items, shown as one connection.')
  })

  it('leaves a non-system type alone', () => {
    const schema = rel({ id: 'FLOWS_TO', name: 'Flows to', description: 'Data moves along this edge.' })
    const fromSchema = getEdgeTypeDefinition('FLOWS_TO', [schema], [])
    expect(fromSchema.label).toBe('Flows to')
    expect(fromSchema.description).toBe('Data moves along this edge.')

    const fallback = getEdgeTypeDefinition('FLOWS_TO', [], [])
    expect(fallback.label).toBe('Flows To')
  })
})
