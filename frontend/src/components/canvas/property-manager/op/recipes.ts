/**
 * recipes — a bulk change kept to run again (a bulk recipe, in the view's library), and back.
 *
 * A recipe keeps the change whole and where it reaches as the Where step names it: the whole view,
 * every entity with a key, a layer by its name, or criteria — never by id, since the entities picked
 * now may not be the ones it should reach next time. Run, it opens the dialog with all of it, and the
 * dialog checks it again (its counts, the server's preview) against the view it runs in.
 */
import type { BulkRecipe, RecipeTarget } from '@/services/viewLibraryService'
import type { OpRequest } from '@/store/propertyJobsStore'
import { searchPreset, type ScopeMode, type TargetPreset } from './opModel'

/** The target a recipe keeps for `preset`, searched in `scopeMode` — or why it can't keep one. */
export function recipeTargetOf(preset: TargetPreset, scopeMode: ScopeMode): { target: RecipeTarget } | { reason: string } {
  switch (preset.kind) {
    case 'view': return { target: { kind: 'view', scopeMode } }
    case 'hasKey': return { target: { kind: 'hasKey', key: preset.key, scopeMode } }
    case 'layer': return { target: { kind: 'layer', layerName: preset.name, scopeMode: 'view' } }
    case 'search': return { target: { kind: 'search', predicate: preset.predicate, scopeMode } }
    case 'connections': return { target: { kind: 'connections', predicate: preset.predicate, scopeMode } }
    case 'custom': return preset.predicate
      ? { target: { kind: 'custom', predicate: preset.predicate, scopeMode } }
      : { reason: 'Add a condition first' }
    case 'selection': return { reason: 'A selection is the entities picked now, and next time others may be meant. Choose the whole view, a key, a layer or criteria to keep it as a recipe.' }
    case 'relationships': return { reason: 'Picked relationships are the ones chosen now, and next time others may be meant. Use a Connections search to keep it as a recipe.' }
    case 'children':
    case 'inside': return { reason: 'A container is named by the one picked now. Choose criteria or a layer to keep it as a recipe.' }
  }
}

/** Where a recipe reaches, in a few words ("every entity with owner"). */
export function recipeTargetLabel(target: RecipeTarget): string {
  const across = target.scopeMode === 'data_source' ? ', across the whole data source' : ''
  switch (target.kind) {
    case 'view': return `every entity in the view${across}`
    case 'hasKey': return `every entity with ${target.key}${across}`
    case 'layer': return `the ${target.layerName} layer`
    case 'search': return `a search’s matches${across}`
    case 'custom': return `the entities matching its criteria${across}`
    case 'connections': return `a Connections search’s relationships${across}`
  }
}

/** The dialog's seed for running `recipe` here: its change whole, its target as the Where step
 *  names it, and its scope. A layer is found by its name among `layers`; when none has it,
 *  `missingLayer` names it and the dialog is left to ask where. */
export function recipeRequest(recipe: BulkRecipe, layers: readonly { id: string; name: string }[]): { request: OpRequest; missingLayer?: string } {
  const op = recipe.op
  const target = recipe.target
  const scopeMode: ScopeMode = target.scopeMode ?? 'view'
  switch (target.kind) {
    case 'view': return { request: { op, target: { kind: 'view' }, scopeMode } }
    case 'hasKey': return { request: { op, target: { kind: 'hasKey', key: target.key }, scopeMode } }
    case 'layer': {
      const layer = layers.find((l) => l.name === target.layerName)
      return layer
        ? { request: { op, target: { kind: 'layer', layerId: layer.id, name: layer.name } } }
        : { request: { op }, missingLayer: target.layerName }
    }
    case 'search':
    case 'connections': return { request: { op, target: searchPreset(target.predicate, scopeMode) } }
    case 'custom': return { request: { op, target: { kind: 'custom', predicate: target.predicate }, scopeMode } }
  }
}
