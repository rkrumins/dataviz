/**
 * opModel — a bulk property change as the dialog builds it: each target is the search the server
 * walks (a container's children are one level down from it, everything inside is every level, a
 * layer is searched in the view), the operation is sent only once it is whole, and Review counts
 * what it will change, replace and leave alone.
 */
import { describe, expect, it } from 'vitest'

import {
  impactOf, jobOp, needsTypedConfirm, opProblem, predicateOf, reviewCounts, targetLabel, targetOf, type OpDraft,
} from '../opModel'

const op = (patch: Partial<OpDraft>): OpDraft => ({ kind: 'set', key: 'owner', to: '', value: 'ana', onConflict: 'skip', ...patch })

describe('targets', () => {
  it('a container\'s children are one level down from it; several containers are any of them', () => {
    expect(predicateOf({ kind: 'children', urns: ['urn:a'], label: 'A' }))
      .toEqual({ kind: 'related', axis: 'parent', where: { kind: 'is', refs: [{ urn: 'urn:a' }] } })
    expect(predicateOf({ kind: 'children', urns: ['urn:a', 'urn:b'], label: '2' }))
      .toMatchObject({ kind: 'group', op: 'or', children: [{ axis: 'parent' }, { axis: 'parent' }] })
  })

  it('everything inside is every level down — the container itself only when asked', () => {
    expect(predicateOf({ kind: 'inside', urns: ['urn:a'], label: 'A', includeSelf: false }))
      .toEqual({ kind: 'related', axis: 'ancestor', where: { kind: 'is', refs: [{ urn: 'urn:a' }] } })
    expect(predicateOf({ kind: 'inside', urns: ['urn:a'], label: 'A', includeSelf: true }))
      .toEqual({ kind: 'descendantOf', urns: ['urn:a'] })
  })

  it('a layer is searched in the view, whatever scope was chosen', () => {
    expect(targetOf({ kind: 'layer', layerId: 'L1', name: 'Gold' }, 'v1', 'data_source'))
      .toEqual({ viewId: 'v1', predicate: { kind: 'layer', layerAssignment: 'L1' }, scopeMode: 'view' })
    expect(targetOf({ kind: 'view' }, 'v1', 'data_source')).toEqual({ viewId: 'v1', predicate: { kind: 'all' }, scopeMode: 'data_source' })
  })

  it('a selection is sent as its ids; criteria not finished are not sent at all', () => {
    expect(targetOf({ kind: 'selection', ids: ['a', 'b'] }, 'v1', 'view')).toEqual({ ids: ['a', 'b'] })
    expect(targetOf({ kind: 'custom', predicate: null }, 'v1', 'view')).toBeNull()
  })

  it('reads as a sentence', () => {
    expect(targetLabel({ kind: 'children', urns: ['urn:a'], label: 'Orders' })).toBe('the children of Orders')
    expect(targetLabel({ kind: 'selection', ids: ['a', 'b', 'c'] })).toBe('the 3 selected')
  })
})

describe('the operation', () => {
  it('is whole only with a usable name, a new name that differs, and a value where one is needed', () => {
    expect(opProblem(op({}))).toBeNull()
    expect(opProblem(op({ key: ' ' }))).toBe('Name the property')
    expect(opProblem(op({ key: 'urn' }))).toMatch(/kept by the platform/)
    expect(opProblem(op({ value: '' }))).toBe('Give it a value')
    expect(opProblem(op({ kind: 'rename', to: '' }))).toBe('Name the new property')
    expect(opProblem(op({ kind: 'rename', to: 'owner' }))).toMatch(/same as the old one/)
    expect(opProblem(op({ kind: 'remove', value: undefined }))).toBeNull()
  })

  it('is sent with only what its kind uses', () => {
    expect(jobOp(op({ key: ' owner ' }))).toEqual({ kind: 'set', key: 'owner', value: 'ana' })
    expect(jobOp(op({ kind: 'rename', to: 'steward', onConflict: 'overwrite' })))
      .toEqual({ kind: 'rename', key: 'owner', to: 'steward', onConflict: 'overwrite' })
    expect(jobOp(op({ kind: 'remove' }))).toEqual({ kind: 'remove', key: 'owner' })
  })
})

describe('review', () => {
  const target = { kind: 'all' } as never

  it('counts the target, those holding the property, and those holding the new name', () => {
    expect(reviewCounts(op({ kind: 'copy', to: 'lead' }), target).map((c) => c.id)).toEqual(['target', 'haveKey', 'haveTo'])
    expect(reviewCounts(op({}), target)[1]!.predicate)
      .toEqual({ kind: 'group', op: 'and', children: [target, { kind: 'hasProperty', key: 'owner', negate: false }] })
  })

  it('says what each operation changes, replaces and leaves alone', () => {
    const c = { target: 100, haveKey: 40, haveTo: 10 }
    expect(impactOf(op({ kind: 'set' }), c)).toEqual({ changes: 100, replaced: 40, untouched: 0 })
    expect(impactOf(op({ kind: 'fillEmpty' }), c)).toEqual({ changes: 60, replaced: 0, untouched: 40 })
    expect(impactOf(op({ kind: 'remove' }), c)).toEqual({ changes: 40, replaced: 0, untouched: 60 })
    expect(impactOf(op({ kind: 'rename', to: 'x' }), c)).toEqual({ changes: 30, replaced: 0, untouched: 70 })
    expect(impactOf(op({ kind: 'rename', to: 'x', onConflict: 'overwrite' }), c)).toEqual({ changes: 40, replaced: 10, untouched: 60 })
  })

  it('asks for the name to be typed for a large or source-wide removal, rename or overwrite', () => {
    expect(needsTypedConfirm(op({ kind: 'remove' }), { changes: 1000, replaced: 0 }, 'view')).toBe(true)
    expect(needsTypedConfirm(op({ kind: 'remove' }), { changes: 10, replaced: 0 }, 'data_source')).toBe(true)
    expect(needsTypedConfirm(op({ kind: 'remove' }), { changes: 10, replaced: 0 }, 'view')).toBe(false)
    expect(needsTypedConfirm(op({ kind: 'set' }), { changes: 5000, replaced: 0 }, 'view')).toBe(false)
    expect(needsTypedConfirm(op({ kind: 'set' }), { changes: 5000, replaced: 1200 }, 'view')).toBe(true)
    expect(needsTypedConfirm(op({ kind: 'fillEmpty' }), { changes: 5000, replaced: 0 }, 'data_source')).toBe(false)
  })
})
