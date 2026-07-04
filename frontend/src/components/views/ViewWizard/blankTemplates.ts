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
function scaffold(templateId: string, columns: Array<[name: string, description: string]>): ViewLayerConfig[] {
  return columns.map(([name, description], i) => {
    const palette = PALETTE[i % PALETTE.length]
    return {
      id: `${templateId}-${i}`,
      name,
      description,
      color: palette.color,
      icon: palette.icon,
      entityTypes: [],
      order: i,
    }
  })
}

/**
 * The Quick Start templates offered to a blank model, in display order. The
 * `ontology` template mirrors {@link deriveLayersFromOntology} for the given
 * schema; the rest are fixed, schema-independent scaffolds.
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
      id: 'blank-tpl-1',
      name: 'Source to target',
      description: 'Trace where data comes from, how it changes, and where it ends up.',
      layers: scaffold('blank-tpl-1', [
        ['Sources', 'Where the data originates'],
        ['Transformations', 'How the data is shaped along the way'],
        ['Targets', 'Where the data lands'],
      ]),
    },
    {
      id: 'blank-tpl-2',
      name: 'Medallion',
      description: 'The lakehouse refinement pattern: raw data lands in Bronze and is progressively refined to business-ready Gold.',
      layers: scaffold('blank-tpl-2', [
        ['Bronze', 'Raw data as it arrives'],
        ['Silver', 'Cleansed and conformed'],
        ['Gold', 'Business-ready data products'],
      ]),
    },
    {
      id: 'blank-tpl-3',
      name: 'Data flow',
      description: 'Map which systems produce data, the pipelines that move it, and who consumes it.',
      layers: scaffold('blank-tpl-3', [
        ['Producers', 'Systems that create data'],
        ['Pipelines', 'Jobs that move and process it'],
        ['Consumers', 'Reports, apps and teams using it'],
      ]),
    },
    {
      id: 'empty',
      name: 'Start empty',
      description: 'Begin with a blank canvas and add layers yourself.',
      layers: [],
    },
  ]
}
