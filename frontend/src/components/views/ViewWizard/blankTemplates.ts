/**
 * blankTemplates — Quick Start layer templates for the wizard's "Start from
 * blank" LayoutStep.
 *
 * Blank models used to silently pre-fill their reference layers from the chosen
 * ontology. That hid the choice from the user. Instead we surface an explicit
 * gallery of named starting arrangements — one derived from the ontology and an
 * empty option — beside the template library (whose built-ins carry the generic
 * pipeline shapes), applied with a single click.
 *
 * No React — safe to unit test in isolation.
 */
import type { WorkspaceSchema, ViewLayerConfig } from '@/types/schema'
import { deriveLayersFromOntology } from './blankModel'

export interface BlankTemplate {
  id: string
  name: string
  description: string
  /** The ontology-derived template — visually flagged as the suggested choice. */
  recommended?: boolean
  layers: ViewLayerConfig[]
}

/**
 * The Quick Start templates offered to a blank model, in display order. The
 * `ontology` template mirrors {@link deriveLayersFromOntology} for the given
 * schema; `empty` starts with no layers.
 */
export function blankQuickStartTemplates(schema: WorkspaceSchema): BlankTemplate[] {
  const ontologyLayers = deriveLayersFromOntology(schema)

  // Descriptions explain what each arrangement is FOR — the preview underneath
  // already shows the structure, so repeating the layer names here is noise.
  return [
    {
      id: 'ontology',
      name: 'From your ontology',
      description: 'Columns follow your ontology’s hierarchy, with each level’s entity types already assigned.',
      recommended: true,
      layers: ontologyLayers,
    },
    {
      id: 'empty',
      name: 'Start empty',
      description: 'Begin with a blank canvas and add layers yourself.',
      layers: [],
    },
  ]
}
