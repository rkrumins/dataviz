/**
 * blankModel — pure derivations for the wizard's "Start from blank" path.
 *
 * A blank model has no data source yet, so there is no backend schema endpoint
 * to hydrate the schema store from. Instead we derive the wizard's schema and a
 * sensible starting reference-layout directly from the chosen published ontology
 * definition, mirroring how {@link entityDefToSchema}/{@link relDefToSchema} map
 * an ontology's stored definitions into the frontend schema shape.
 *
 * No React — safe to unit test in isolation.
 */
import type { WorkspaceSchema, ViewLayerConfig, GlobalVisualConfig } from '@/types/schema'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { entityDefToSchema, relDefToSchema } from '@/features/ontology/lib/ontology-parsers'
import { defaultReferenceModelLayers } from '@/components/canvas/context-view/constants'

// Matches the schema store's DEFAULT_GLOBAL_VISUALS — the wizard never edits
// these, but WorkspaceSchema requires them.
const BLANK_GLOBAL_VISUALS: GlobalVisualConfig = {
  theme: 'dark',
  accentColor: '#6366f1',
  fontFamily: 'Inter',
  borderRadius: 'md',
  showConfidenceScores: true,
  animationsEnabled: true,
}

/**
 * Map a published ontology definition into the {@link WorkspaceSchema} the wizard
 * and schema store consume — the same shape `loadFromBackend` produces from the
 * graph-schema endpoint, but sourced from the ontology's own definitions.
 */
export function ontologyToWorkspaceSchema(def: OntologyDefinitionResponse): WorkspaceSchema {
  const entityDefs = (def.entityTypeDefinitions ?? {}) as Record<string, Record<string, unknown>>
  const relDefs = (def.relationshipTypeDefinitions ?? {}) as Record<string, Record<string, unknown>>

  return {
    id: def.schemaId || def.id,
    name: def.name,
    version: String(def.version),
    entityTypes: Object.entries(entityDefs).map(([id, d]) => entityDefToSchema(id, d)),
    relationshipTypes: Object.entries(relDefs).map(([id, d]) => relDefToSchema(id, d)),
    views: [],
    defaultViewId: '',
    globalVisuals: BLANK_GLOBAL_VISUALS,
    containmentEdgeTypes: def.containmentEdgeTypes ?? [],
    lineageEdgeTypes: def.lineageEdgeTypes ?? [],
    rootEntityTypes: def.rootEntityTypes ?? [],
  }
}

/** Mirrors the backend's physical-graph-name contract (versioning.py):
 *  3–64 chars, lowercase alnum with '-'/'_', not starting with punctuation. */
export const GRAPH_NAME_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/

/**
 * Derive a physical FalkorDB graph name from a human model name —
 * "Customer 360 Lineage" → "customer_360_lineage". The user can edit the
 * result; the backend validates authoritatively (reserved prefixes,
 * per-provider uniqueness) at provision time.
 */
export function slugifyGraphName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, 64)
}

/**
 * Derive an ordered set of reference-layout layers from the schema's entity-type
 * hierarchy: one layer per distinct `hierarchy.level`, coarsest (level 0) first,
 * each pre-filled with the entity types at that level and named from their plural
 * names. When the ontology carries no usable level structure (fewer than two
 * distinct levels), fall back to the generic {@link defaultReferenceModelLayers}
 * so the user still gets a starting scaffold to assign types into.
 */
export function deriveLayersFromOntology(schema: WorkspaceSchema): ViewLayerConfig[] {
  const entityTypes = schema.entityTypes ?? []
  const levels = [...new Set(entityTypes.map(et => et.hierarchy?.level ?? 0))].sort((a, b) => a - b)

  if (levels.length < 2) {
    return defaultReferenceModelLayers.map(l => ({ ...l }))
  }

  return levels.map((level, index) => {
    const types = entityTypes
      .filter(et => (et.hierarchy?.level ?? 0) === level)
      .sort((a, b) => a.name.localeCompare(b.name))
    const palette = defaultReferenceModelLayers[index % defaultReferenceModelLayers.length]
    return {
      id: `blank-layer-${index}`,
      name: types.map(t => t.pluralName).join(' · ') || `Level ${level}`,
      color: palette.color,
      icon: palette.icon,
      entityTypes: types.map(t => t.id),
      order: index,
    }
  })
}
