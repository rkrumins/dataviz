/**
 * The schema as the server serves it, read into the store: a relationship type keeps the fields a
 * publish judges its relationships by, as an entity type does — and a schema without them (an
 * older server's) reads as it always did.
 */
import { describe, expect, it } from 'vitest'
import { convertBackendRelationshipType } from '@/store/schema'
import type { RelationshipTypeDefinition } from '@/providers/GraphDataProvider'

const owns = (extra: Partial<RelationshipTypeDefinition> = {}): RelationshipTypeDefinition => ({
  id: 'OWNS', name: 'Owns', sourceTypes: [], targetTypes: [],
  visual: { strokeColor: '#6366f1', strokeWidth: 2, strokeStyle: 'solid', animated: true, animationSpeed: 'normal', arrowType: 'arrow', curveType: 'bezier' },
  bidirectional: false, showLabel: false, isContainment: false, isLineage: true, category: 'flow', ...extra,
})

describe('convertBackendRelationshipType', () => {
  it('keeps a relationship type’s fields, as an entity type’s are kept', () => {
    const rt = convertBackendRelationshipType(owns({ fields: [
      { id: 'since', name: 'Since', type: 'date', required: true, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0 },
      { id: 'tier', name: 'Tier', type: 'status', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 1,
        allowedValues: ['gold'], allowOther: true, format: null },
    ] }))
    expect(rt.fields).toEqual([
      { id: 'since', name: 'Since', type: 'date', required: true, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0 },
      { id: 'tier', name: 'Tier', type: 'status', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 1,
        allowedValues: ['gold'], allowOther: true },
    ])
  })

  it('reads a type served without fields as it always did', () => {
    expect('fields' in convertBackendRelationshipType(owns())).toBe(false)
    expect('fields' in convertBackendRelationshipType(owns({ fields: [] }))).toBe(false)
  })
})
