/**
 * blankTemplates — Quick Start layer templates for the wizard's "Start from
 * blank" LayoutStep.
 *
 * Blank models used to silently pre-fill their reference layers from the chosen
 * ontology. That hid the choice from the user. Instead we surface an explicit
 * gallery of named starting arrangements — one derived from the ontology, a few
 * generic pipeline shapes, and an empty option — that the user applies with a
 * single click.
 *
 * No React — safe to unit test in isolation.
 */
import type { WorkspaceSchema, ViewLayerConfig } from '@/types/schema'
import { deriveLayersFromOntology } from './blankModel'
import { defaultReferenceModelLayers } from '@/components/canvas/context-view/constants'

export interface BlankTemplate {
  id: string
  name: string
  description: string
  /** The ontology-derived template — visually flagged as the suggested choice. */
  recommended?: boolean
  layers: ViewLayerConfig[]
}

/** Color + icon palette, borrowed from the reference-model defaults so blank
 *  templates read as the same visual family as ontology-derived layers. */
const PALETTE = defaultReferenceModelLayers

/** Build an ordered set of empty scaffold layers for a generic template. */
function scaffold(templateId: string, names: string[]): ViewLayerConfig[] {
  return names.map((name, i) => {
    const palette = PALETTE[i % PALETTE.length]
    return {
      id: `${templateId}-${i}`,
      name,
      color: palette.color,
      icon: palette.icon,
      entityTypes: [],
      order: i,
    }
  })
}

/** Human-readable summary of a layer set, used as a template's description. */
function describeLayers(layers: ViewLayerConfig[]): string {
  if (layers.length === 0) return 'No layers yet'
  return layers.map(l => l.name).join(' → ')
}

/**
 * The Quick Start templates offered to a blank model, in display order. The
 * `ontology` template mirrors {@link deriveLayersFromOntology} for the given
 * schema; the rest are fixed, schema-independent scaffolds.
 */
export function blankQuickStartTemplates(schema: WorkspaceSchema): BlankTemplate[] {
  const ontologyLayers = deriveLayersFromOntology(schema)

  return [
    {
      id: 'ontology',
      name: 'From your ontology',
      description: describeLayers(ontologyLayers),
      recommended: true,
      layers: ontologyLayers,
    },
    {
      id: 'blank-tpl-1',
      name: 'Source to target',
      description: 'Sources → Transformations → Targets',
      layers: scaffold('blank-tpl-1', ['Sources', 'Transformations', 'Targets']),
    },
    {
      id: 'blank-tpl-2',
      name: 'Medallion',
      description: 'Bronze → Silver → Gold',
      layers: scaffold('blank-tpl-2', ['Bronze', 'Silver', 'Gold']),
    },
    {
      id: 'blank-tpl-3',
      name: 'Data flow',
      description: 'Producers → Pipelines → Consumers',
      layers: scaffold('blank-tpl-3', ['Producers', 'Pipelines', 'Consumers']),
    },
    {
      id: 'empty',
      name: 'Start empty',
      description: 'Begin with a blank canvas and add layers yourself',
      layers: [],
    },
  ]
}
