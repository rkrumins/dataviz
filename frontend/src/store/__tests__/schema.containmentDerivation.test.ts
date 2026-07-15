/**
 * Containment must survive a payload that carries the per-relationship
 * `isContainment` flags but an EMPTY top-level `containmentEdgeTypes` array.
 *
 * A schema has two redundant containment signals (the top-level array AND
 * `relationshipTypes[].isContainment`). The `cached-ontology` synthetic
 * fallback ships only the flags; a stale cache can ship an empty array. If the
 * store trusts the array alone, the whole hierarchy silently goes flat and the
 * canvas shows "No containment types configured" even though the ontology has
 * containment. The store must fall back to the flags.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useSchemaStore, deriveContainmentEdgeTypes, deriveLineageEdgeTypes } from '../schema'
import type { GraphSchema } from '@/providers/GraphDataProvider'

function entityType(id: string) {
  return {
    id,
    name: id,
    pluralName: `${id}s`,
    description: '',
    visual: { icon: 'Box', color: '#fff', shape: 'rectangle', size: 'medium', borderStyle: 'solid', showInMinimap: true },
    fields: [],
    hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false },
    behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
  }
}

function relType(id: string, isContainment: boolean, isLineage = false) {
  return {
    id,
    name: id,
    description: '',
    sourceTypes: ['platform'],
    targetTypes: ['platform'],
    visual: { strokeColor: '#888', strokeWidth: 1, strokeStyle: 'solid', animated: false, animationSpeed: 'normal', arrowType: 'arrow', curveType: 'bezier' },
    bidirectional: false,
    showLabel: true,
    isContainment,
    isLineage,
    category: 'association',
  }
}

function graphSchema(over: Partial<GraphSchema> = {}): GraphSchema {
  return {
    version: '1.0.0',
    entityTypes: [entityType('platform')],
    relationshipTypes: [],
    rootEntityTypes: ['platform'],
    containmentEdgeTypes: [],
    lineageEdgeTypes: [],
    ontologyDigest: null,
    ...over,
  } as GraphSchema
}

const SCOPE = { workspaceId: 'ws1', dataSourceId: 'ds1' }

describe('deriveContainmentEdgeTypes', () => {
  it('returns the ids of relationships flagged isContainment', () => {
    expect(
      deriveContainmentEdgeTypes([
        { id: 'HAS_COLUMN', isContainment: true },
        { id: 'FLOWS_TO', isContainment: false },
        { id: 'CONTAINS', isContainment: true },
      ]),
    ).toEqual(['HAS_COLUMN', 'CONTAINS'])
  })

  it('returns empty when no relationship is containment', () => {
    expect(deriveContainmentEdgeTypes([{ id: 'FLOWS_TO', isContainment: false }])).toEqual([])
    expect(deriveContainmentEdgeTypes([])).toEqual([])
  })
})

describe('deriveLineageEdgeTypes', () => {
  it('returns the ids of relationships flagged isLineage', () => {
    expect(
      deriveLineageEdgeTypes([
        { id: 'FLOWS_TO', isLineage: true },
        { id: 'HAS_COLUMN', isLineage: false },
        { id: 'DERIVES_FROM', isLineage: true },
      ]),
    ).toEqual(['FLOWS_TO', 'DERIVES_FROM'])
  })

  it('returns empty when no relationship is lineage', () => {
    expect(deriveLineageEdgeTypes([{ id: 'HAS_COLUMN', isLineage: false }])).toEqual([])
    expect(deriveLineageEdgeTypes([])).toEqual([])
  })
})

describe('schema store — containment fallback from isContainment flags', () => {
  beforeEach(() => {
    useSchemaStore.getState().reset()
  })

  it('derives containmentEdgeTypes from flags when the top-level array is empty', () => {
    useSchemaStore.getState().loadFromBackend(
      graphSchema({
        containmentEdgeTypes: [],
        relationshipTypes: [relType('HAS_COLUMN', true), relType('FLOWS_TO', false)] as any,
      }),
      SCOPE,
    )

    expect(useSchemaStore.getState().schema?.containmentEdgeTypes).toEqual(['HAS_COLUMN'])
  })

  it('prefers the explicit top-level array when it is present', () => {
    useSchemaStore.getState().loadFromBackend(
      graphSchema({
        containmentEdgeTypes: ['CONTAINS'],
        relationshipTypes: [relType('HAS_COLUMN', true)] as any,
      }),
      SCOPE,
    )

    expect(useSchemaStore.getState().schema?.containmentEdgeTypes).toEqual(['CONTAINS'])
  })

  it('derives lineageEdgeTypes from flags when the top-level array is empty', () => {
    useSchemaStore.getState().loadFromBackend(
      graphSchema({
        lineageEdgeTypes: [],
        relationshipTypes: [relType('FLOWS_TO', false, true), relType('HAS_COLUMN', true, false)] as any,
      }),
      SCOPE,
    )

    expect(useSchemaStore.getState().schema?.lineageEdgeTypes).toEqual(['FLOWS_TO'])
  })
})
