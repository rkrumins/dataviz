import { describe, it, expect } from 'vitest'

import { ontologyToWorkspaceSchema, deriveLayersFromOntology } from '../blankModel'
import { defaultReferenceModelLayers } from '@/components/canvas/context-view/constants'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

/** Build a minimal published-ontology definition; only the fields the parsers read matter. */
function makeOntology(over: Partial<OntologyDefinitionResponse> = {}): OntologyDefinitionResponse {
  return {
    id: 'ont1',
    schemaId: 'sch1',
    name: 'Test Ontology',
    description: null,
    version: 3,
    revision: 0,
    evolutionPolicy: 'additive',
    containmentEdgeTypes: ['CONTAINS'],
    lineageEdgeTypes: ['FLOWS_TO'],
    edgeTypeMetadata: {},
    entityTypeHierarchy: {},
    rootEntityTypes: ['domain'],
    entityTypeDefinitions: {
      domain: {
        name: 'Domain',
        plural_name: 'Domains',
        visual: { color: '#111111' },
        hierarchy: { level: 0, can_contain: ['dataset'] },
      },
      dataset: {
        name: 'Dataset',
        plural_name: 'Datasets',
        hierarchy: { level: 1 },
      },
    },
    relationshipTypeDefinitions: {
      CONTAINS: {
        name: 'Contains',
        is_containment: true,
        source_types: ['domain'],
        target_types: ['dataset'],
      },
      FLOWS_TO: {
        name: 'Flows To',
        is_lineage: true,
      },
    },
    isPublished: true,
    isSystem: false,
    scope: 'universal',
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    publishedAt: null,
    deletedBy: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  }
}

describe('ontologyToWorkspaceSchema', () => {
  it('maps identity + top-level edge/root lists', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    expect(schema.id).toBe('sch1')
    expect(schema.name).toBe('Test Ontology')
    expect(schema.version).toBe('3')
    expect(schema.containmentEdgeTypes).toEqual(['CONTAINS'])
    expect(schema.lineageEdgeTypes).toEqual(['FLOWS_TO'])
    expect(schema.rootEntityTypes).toEqual(['domain'])
    expect(schema.views).toEqual([])
  })

  it('maps entity type definitions incl. plural name, visual, and hierarchy', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    const domain = schema.entityTypes.find(e => e.id === 'domain')
    expect(domain).toBeDefined()
    expect(domain!.name).toBe('Domain')
    expect(domain!.pluralName).toBe('Domains')
    expect(domain!.visual.color).toBe('#111111')
    expect(domain!.hierarchy.level).toBe(0)
    expect(domain!.hierarchy.canContain).toEqual(['dataset'])
    // dataset omits plural_name → parser derives it
    const dataset = schema.entityTypes.find(e => e.id === 'dataset')
    expect(dataset!.hierarchy.level).toBe(1)
  })

  it('classifies containment vs lineage relationship types', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    const contains = schema.relationshipTypes.find(r => r.id === 'CONTAINS')
    const flows = schema.relationshipTypes.find(r => r.id === 'FLOWS_TO')
    expect(contains!.isContainment).toBe(true)
    expect(contains!.isLineage).toBe(false)
    expect(contains!.sourceTypes).toEqual(['domain'])
    expect(contains!.targetTypes).toEqual(['dataset'])
    expect(flows!.isLineage).toBe(true)
    expect(flows!.isContainment).toBe(false)
  })

  it('tolerates an ontology with no definitions', () => {
    const schema = ontologyToWorkspaceSchema(
      makeOntology({ entityTypeDefinitions: {}, relationshipTypeDefinitions: {} }),
    )
    expect(schema.entityTypes).toEqual([])
    expect(schema.relationshipTypes).toEqual([])
  })
})

describe('deriveLayersFromOntology', () => {
  it('groups entity types into ordered layers by hierarchy level', () => {
    const schema = ontologyToWorkspaceSchema(
      makeOntology({
        entityTypeDefinitions: {
          domain: { name: 'Domain', plural_name: 'Domains', hierarchy: { level: 0 } },
          platform: { name: 'Platform', plural_name: 'Platforms', hierarchy: { level: 0 } },
          dataset: { name: 'Dataset', plural_name: 'Datasets', hierarchy: { level: 1 } },
          column: { name: 'Column', plural_name: 'Columns', hierarchy: { level: 2 } },
        },
      }),
    )
    const layers = deriveLayersFromOntology(schema)
    expect(layers).toHaveLength(3)
    // Level 0 groups both coarse types, sorted by name.
    expect(layers[0].entityTypes).toEqual(['domain', 'platform'])
    expect(layers[0].name).toBe('Domains · Platforms')
    expect(layers[0].order).toBe(0)
    expect(layers[1].entityTypes).toEqual(['dataset'])
    expect(layers[1].name).toBe('Datasets')
    expect(layers[2].entityTypes).toEqual(['column'])
    expect(layers.every(l => !!l.color)).toBe(true)
  })

  it('falls back to the default layers when levels do not differentiate', () => {
    const schema = ontologyToWorkspaceSchema(
      makeOntology({
        entityTypeDefinitions: {
          a: { name: 'A', hierarchy: { level: 0 } },
          b: { name: 'B', hierarchy: { level: 0 } },
        },
        relationshipTypeDefinitions: {},
      }),
    )
    const layers = deriveLayersFromOntology(schema)
    expect(layers.map(l => l.name)).toEqual(defaultReferenceModelLayers.map(l => l.name))
    // Returns a copy, not the shared module-level array.
    expect(layers[0]).not.toBe(defaultReferenceModelLayers[0])
  })

  it('falls back for an empty schema', () => {
    const schema = ontologyToWorkspaceSchema(
      makeOntology({ entityTypeDefinitions: {}, relationshipTypeDefinitions: {} }),
    )
    expect(deriveLayersFromOntology(schema)).toHaveLength(defaultReferenceModelLayers.length)
  })
})
