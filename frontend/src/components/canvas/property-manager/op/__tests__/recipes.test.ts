/**
 * recipes — a reviewed change kept as a recipe, and a recipe opened in the dialog again: where it
 * reaches is kept as the Where step names it, never by id, and a layer is found by its name.
 */
import { describe, expect, it } from 'vitest'

import type { BulkRecipe } from '@/services/viewLibraryService'
import type { Predicate } from '@/types/search'

import { recipeRequest, recipeTargetLabel, recipeTargetOf } from '../recipes'

const pii = { kind: 'hasProperty', key: 'pii', negate: false } as Predicate
const flows = { kind: 'edges', edgeTypes: ['FLOWS_TO'] } as unknown as Predicate

const recipe = (target: BulkRecipe['target']): BulkRecipe => ({
  id: 'r1', name: 'Own them', op: { kind: 'set', key: 'owner', value: 'data-team', onConflict: 'skip' }, target,
})

describe('recipeTargetOf', () => {
  it('keeps the view, a key, a layer by name and criteria — with where they are searched', () => {
    expect(recipeTargetOf({ kind: 'view' }, 'data_source')).toEqual({ target: { kind: 'view', scopeMode: 'data_source' } })
    expect(recipeTargetOf({ kind: 'hasKey', key: 'owner' }, 'view')).toEqual({ target: { kind: 'hasKey', key: 'owner', scopeMode: 'view' } })
    expect(recipeTargetOf({ kind: 'layer', layerId: 'L1', name: 'Gold' }, 'view')).toEqual({ target: { kind: 'layer', layerName: 'Gold', scopeMode: 'view' } })
    expect(recipeTargetOf({ kind: 'search', predicate: pii, scopeMode: 'view', label: 'x', count: 3 }, 'view'))
      .toEqual({ target: { kind: 'search', predicate: pii, scopeMode: 'view' } })
    expect(recipeTargetOf({ kind: 'custom', predicate: pii }, 'data_source')).toEqual({ target: { kind: 'custom', predicate: pii, scopeMode: 'data_source' } })
    expect(recipeTargetOf({ kind: 'connections', predicate: flows, scopeMode: 'view', label: 'x' }, 'view'))
      .toEqual({ target: { kind: 'connections', predicate: flows, scopeMode: 'view' } })
  })

  it('says why entities picked by id can’t be kept', () => {
    for (const preset of [
      { kind: 'selection', ids: ['u1'] },
      { kind: 'relationships', ids: ['e1'] },
      { kind: 'children', urns: ['u1'], label: 'Orders' },
      { kind: 'inside', urns: ['u1'], label: 'Orders', includeSelf: true },
    ] as const) {
      const kept = recipeTargetOf(preset, 'view')
      expect(kept).toEqual({ reason: expect.stringMatching(/to keep it as a recipe/) })
    }
    expect(recipeTargetOf({ kind: 'custom', predicate: null }, 'view')).toEqual({ reason: 'Add a condition first' })
  })
})

describe('recipeRequest', () => {
  const layers = [{ id: 'L1', name: 'Gold' }, { id: 'L2', name: 'Silver' }]

  it('opens the dialog with the whole change, the target as the Where step names it, and its scope', () => {
    const op = recipe({ kind: 'view' }).op
    expect(recipeRequest(recipe({ kind: 'view', scopeMode: 'data_source' }), layers))
      .toEqual({ request: { op, target: { kind: 'view' }, scopeMode: 'data_source' } })
    expect(recipeRequest(recipe({ kind: 'hasKey', key: 'owner' }), layers))
      .toEqual({ request: { op, target: { kind: 'hasKey', key: 'owner' }, scopeMode: 'view' } })
    expect(recipeRequest(recipe({ kind: 'custom', predicate: pii, scopeMode: 'data_source' }), layers))
      .toEqual({ request: { op, target: { kind: 'custom', predicate: pii }, scopeMode: 'data_source' } })
    expect(recipeRequest(recipe({ kind: 'search', predicate: pii, scopeMode: 'data_source' }), layers).request.target)
      .toMatchObject({ kind: 'search', predicate: pii, scopeMode: 'data_source' })
    expect(recipeRequest(recipe({ kind: 'connections', predicate: flows }), layers).request.target)
      .toMatchObject({ kind: 'connections', predicate: flows, scopeMode: 'view' })
  })

  it('finds a layer by its name here — and, when this view has none by that name, leaves the dialog to ask', () => {
    expect(recipeRequest(recipe({ kind: 'layer', layerName: 'Silver' }), layers).request.target)
      .toEqual({ kind: 'layer', layerId: 'L2', name: 'Silver' })
    const missing = recipeRequest(recipe({ kind: 'layer', layerName: 'Bronze' }), layers)
    expect(missing).toEqual({ request: { op: recipe({ kind: 'view' }).op }, missingLayer: 'Bronze' })
  })
})

describe('recipeTargetLabel', () => {
  it('says where it reaches, and when that is the whole data source', () => {
    expect(recipeTargetLabel({ kind: 'hasKey', key: 'owner', scopeMode: 'data_source' })).toBe('every entity with owner, across the whole data source')
    expect(recipeTargetLabel({ kind: 'layer', layerName: 'Gold' })).toBe('the Gold layer')
  })
})
