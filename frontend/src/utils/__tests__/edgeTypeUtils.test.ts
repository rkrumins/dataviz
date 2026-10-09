/**
 * `getEdgeTypeDefinition` — what this app owns about a system edge type, and
 * what it must leave to the ontology (2026-08-30).
 *
 * `AGGREGATED` is a system type the aggregation worker writes; its ontology
 * name ("Aggregated"), description and visuals are seeded per data source and
 * add-only, so they cannot be corrected at the source without a backfill. Two
 * things are owned here: the WORD, and the DASH — every AGGREGATED edge is a
 * roll-up, and the canvas draws roll-ups dashed whatever the seed says. Colour
 * and animation stay the ontology's to decide.
 */
import { describe, it, expect } from 'vitest'
import type { RelationshipTypeSchema } from '@/types/schema'
import { getEdgeTypeDefinition, appOwnedStrokeStyle } from '../edgeTypeUtils'

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
  it('overrides the schema name and description, keeping the schema colour and animation', () => {
    const def = getEdgeTypeDefinition('AGGREGATED', [rel({})], [])
    expect(def.label).toBe('Combined flow')
    expect(def.description).toBe('Many detailed flows between two items, shown as one connection.')
    expect(def.color).toBe('#22c55e')
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

/**
 * The stroke style this app owns. Live dev stack, 2026-08-30: the ontology on
 * ws_438429af72a9 declares AGGREGATED as `solid`, while the canvas draws every
 * one of those edges dashed (`edgeDashArray(isRollup=true)` — an AGGREGATED
 * edge is a roll-up by construction). The Flows-panel swatch and the edge
 * legend read this definition, so with `solid` they drew a solid sample for a
 * line the canvas draws dashed.
 */
describe('getEdgeTypeDefinition — AGGREGATED stroke is app-owned', () => {
  it('draws AGGREGATED dashed even when the ontology declares solid', () => {
    const def = getEdgeTypeDefinition('AGGREGATED', [rel({})], [])
    expect(def.strokeStyle).toBe('dashed')
  })

  it('draws AGGREGATED dashed in the default branch too', () => {
    expect(getEdgeTypeDefinition('AGGREGATED', [], []).strokeStyle).toBe('dashed')
  })

  it('matches case-insensitively on the type id', () => {
    expect(getEdgeTypeDefinition('aggregated', [], []).strokeStyle).toBe('dashed')
  })

  it('leaves a non-system type\'s declared stroke alone', () => {
    const dotted = rel({ id: 'TAGGED_WITH', name: 'Tagged with', visual: { ...rel({}).visual, strokeStyle: 'dotted' } })
    expect(getEdgeTypeDefinition('TAGGED_WITH', [dotted], []).strokeStyle).toBe('dotted')

    const dashed = rel({ id: 'DEPENDS_ON', name: 'Depends on', visual: { ...rel({}).visual, strokeStyle: 'dashed' } })
    expect(getEdgeTypeDefinition('DEPENDS_ON', [dashed], []).strokeStyle).toBe('dashed')

    const solid = rel({ id: 'PRODUCES', name: 'Produces', visual: { ...rel({}).visual, strokeStyle: 'solid' } })
    expect(getEdgeTypeDefinition('PRODUCES', [solid], []).strokeStyle).toBe('solid')
  })
})

/**
 * The same ownership, readable from outside — the ontology editor's line-style
 * advisory describes what the CANVAS draws, so it has to resolve AGGREGATED the
 * way the canvas does rather than reading the ontology's declared `solid` and
 * naming it as a solid twin of everything else.
 */
describe('appOwnedStrokeStyle', () => {
  it('claims the system roll-up', () => {
    expect(appOwnedStrokeStyle('AGGREGATED')).toBe('dashed')
    expect(appOwnedStrokeStyle('aggregated')).toBe('dashed')
  })

  it('claims nothing else, so the ontology s declared stroke stands', () => {
    expect(appOwnedStrokeStyle('FLOWS_TO')).toBeNull()
    expect(appOwnedStrokeStyle('')).toBeNull()
  })
})
