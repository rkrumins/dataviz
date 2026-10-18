import { describe, it, expect } from 'vitest'

import { blankQuickStartTemplates } from '../blankTemplates'
import { ontologyToWorkspaceSchema, deriveLayersFromOntology } from '../blankModel'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

/** Minimal published ontology with a two-level hierarchy so the ontology
 *  template derives real (non-fallback) layers. */
function makeOntology(over: Partial<OntologyDefinitionResponse> = {}): OntologyDefinitionResponse {
  return {
    id: 'ont1',
    schemaId: 'sch1',
    name: 'Test Ontology',
    description: null,
    version: 1,
    revision: 0,
    evolutionPolicy: 'additive',
    containmentEdgeTypes: [],
    lineageEdgeTypes: [],
    edgeTypeMetadata: {},
    entityTypeHierarchy: {},
    rootEntityTypes: [],
    entityTypeDefinitions: {
      domain: { name: 'Domain', plural_name: 'Domains', hierarchy: { level: 0 } },
      dataset: { name: 'Dataset', plural_name: 'Datasets', hierarchy: { level: 1 } },
    },
    relationshipTypeDefinitions: {},
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

describe('blankQuickStartTemplates', () => {
  it('offers the ontology and an empty template — the generic shapes are built-ins in the library', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    const templates = blankQuickStartTemplates(schema)
    expect(templates.map(t => t.id)).toEqual(['ontology', 'empty'])
  })

  it('marks only the ontology template as recommended', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    const templates = blankQuickStartTemplates(schema)
    expect(templates.filter(t => t.recommended).map(t => t.id)).toEqual(['ontology'])
  })

  it('mirrors deriveLayersFromOntology for the ontology template', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    const ontologyTemplate = blankQuickStartTemplates(schema).find(t => t.id === 'ontology')!
    expect(ontologyTemplate.layers).toEqual(deriveLayersFromOntology(schema))
    // Its description explains the arrangement's PURPOSE — the gallery preview
    // already shows the layer names, so the copy must not just repeat them.
    expect(ontologyTemplate.description.length).toBeGreaterThan(0)
    expect(ontologyTemplate.description).not.toContain('→')
  })

  it('gives every template unique layer ids and 0..n orders', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    for (const template of blankQuickStartTemplates(schema)) {
      const ids = template.layers.map(l => l.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(template.layers.map(l => l.order)).toEqual(template.layers.map((_, i) => i))
      expect(template.layers.every(l => !!l.color)).toBe(true)
    }
  })

  it('has unique template ids', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    const ids = blankQuickStartTemplates(schema).map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('produces an empty template with no layers', () => {
    const schema = ontologyToWorkspaceSchema(makeOntology())
    const empty = blankQuickStartTemplates(schema).find(t => t.id === 'empty')!
    expect(empty.layers).toEqual([])
  })
})
