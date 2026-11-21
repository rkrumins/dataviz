/**
 * reusableChanges — a reviewed change kept for reuse, and a reusable change opened in the dialog
 * again: where it reaches is kept as the Where step names it, never by id, and a layer is found by
 * its name.
 */
import { describe, expect, it } from 'vitest'

import type { ReusableChange } from '@/services/viewLibraryService'
import type { Predicate } from '@/types/search'

import { reusableChangeRequest, reusableChangeTargetLabel, reusableChangeTargetOf } from '../reusableChanges'

const pii = { kind: 'hasProperty', key: 'pii', negate: false } as Predicate
const flows = { kind: 'edges', edgeTypes: ['FLOWS_TO'] } as unknown as Predicate

const change = (target: ReusableChange['target']): ReusableChange => ({
  id: 'r1', name: 'Own them', op: { kind: 'set', key: 'owner', value: 'data-team', onConflict: 'skip' }, target,
})

describe('reusableChangeTargetOf', () => {
  it('keeps the view, a key, a layer by name and criteria — with where they are searched', () => {
    expect(reusableChangeTargetOf({ kind: 'view' }, 'data_source')).toEqual({ target: { kind: 'view', scopeMode: 'data_source' } })
    expect(reusableChangeTargetOf({ kind: 'hasKey', key: 'owner' }, 'view')).toEqual({ target: { kind: 'hasKey', key: 'owner', scopeMode: 'view' } })
    expect(reusableChangeTargetOf({ kind: 'layer', layerId: 'L1', name: 'Gold' }, 'view')).toEqual({ target: { kind: 'layer', layerName: 'Gold', scopeMode: 'view' } })
    expect(reusableChangeTargetOf({ kind: 'search', predicate: pii, scopeMode: 'view', label: 'x', count: 3 }, 'view'))
      .toEqual({ target: { kind: 'search', predicate: pii, scopeMode: 'view' } })
    expect(reusableChangeTargetOf({ kind: 'custom', predicate: pii }, 'data_source')).toEqual({ target: { kind: 'custom', predicate: pii, scopeMode: 'data_source' } })
    expect(reusableChangeTargetOf({ kind: 'connections', predicate: flows, scopeMode: 'view', label: 'x' }, 'view'))
      .toEqual({ target: { kind: 'connections', predicate: flows, scopeMode: 'view' } })
  })

  it('says why entities picked by id can’t be kept', () => {
    for (const preset of [
      { kind: 'selection', ids: ['u1'] },
      { kind: 'relationships', ids: ['e1'] },
      { kind: 'children', urns: ['u1'], label: 'Orders' },
      { kind: 'inside', urns: ['u1'], label: 'Orders', includeSelf: true },
    ] as const) {
      const kept = reusableChangeTargetOf(preset, 'view')
      expect(kept).toEqual({ reason: expect.stringMatching(/to keep it for reuse/) })
    }
    expect(reusableChangeTargetOf({ kind: 'custom', predicate: null }, 'view')).toEqual({ reason: 'Add a condition first' })
  })
})

describe('reusableChangeRequest', () => {
  const layers = [{ id: 'L1', name: 'Gold' }, { id: 'L2', name: 'Silver' }]

  it('opens the dialog with the whole change, the target as the Where step names it, and its scope', () => {
    const { op, name } = change({ kind: 'view' })
    expect(reusableChangeRequest(change({ kind: 'view', scopeMode: 'data_source' }), layers))
      .toEqual({ request: { op, target: { kind: 'view' }, scopeMode: 'data_source', reusable: { name } } })
    expect(reusableChangeRequest(change({ kind: 'hasKey', key: 'owner' }), layers))
      .toEqual({ request: { op, target: { kind: 'hasKey', key: 'owner' }, scopeMode: 'view', reusable: { name } } })
    expect(reusableChangeRequest(change({ kind: 'custom', predicate: pii, scopeMode: 'data_source' }), layers))
      .toEqual({ request: { op, target: { kind: 'custom', predicate: pii }, scopeMode: 'data_source', reusable: { name } } })
    expect(reusableChangeRequest(change({ kind: 'search', predicate: pii, scopeMode: 'data_source' }), layers).request.target)
      .toMatchObject({ kind: 'search', predicate: pii, scopeMode: 'data_source' })
    expect(reusableChangeRequest(change({ kind: 'connections', predicate: flows }), layers).request.target)
      .toMatchObject({ kind: 'connections', predicate: flows, scopeMode: 'view' })
  })

  it('finds a layer by its name here — and, when this view has none by that name, leaves the dialog to ask', () => {
    expect(reusableChangeRequest(change({ kind: 'layer', layerName: 'Silver' }), layers).request.target)
      .toEqual({ kind: 'layer', layerId: 'L2', name: 'Silver' })
    const missing = reusableChangeRequest(change({ kind: 'layer', layerName: 'Bronze' }), layers)
    expect(missing).toEqual({ request: { op: change({ kind: 'view' }).op, reusable: { name: change({ kind: 'view' }).name } }, missingLayer: 'Bronze' })
  })
})

describe('reusableChangeTargetLabel', () => {
  it('says where it reaches, and when that is the whole data source', () => {
    expect(reusableChangeTargetLabel({ kind: 'hasKey', key: 'owner', scopeMode: 'data_source' })).toBe('every entity with owner, across the whole data source')
    expect(reusableChangeTargetLabel({ kind: 'layer', layerName: 'Gold' })).toBe('the Gold layer')
    // Said apart, as the Reusable changes list does with a badge.
    expect(reusableChangeTargetLabel({ kind: 'hasKey', key: 'owner', scopeMode: 'data_source' }, false)).toBe('every entity with owner')
  })
})
