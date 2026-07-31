import { describe, it, expect } from 'vitest'
import {
  assignEntities,
  unassignEntities,
  remapAssignmentUrn,
  pruneTempAssignments,
  isTempUrn,
  setAssignmentOrderKey,
  lastOrderKeyInLayer,
  keyForInsertion,
  keysForInsertion,
  ensureSiblingOrderKeys,
} from '../assignmentMutations'
import { setLayerNodeSortMode } from '../layerMutations'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import type { LayerAssignmentEntry } from '@/types/schema'

const layout = (assignments: Record<string, LayerAssignmentEntry> = {}): NormalizedReferenceLayout => ({
  layers: [{ id: 'l1', name: 'L1', order: 0, entityTypes: [] }],
  assignments,
})

describe('assignmentMutations — assignEntities', () => {
  it('assigns with defaults (inheritsChildren true, assignedBy user, timestamp set)', () => {
    const next = assignEntities(layout(), ['urn:a'], 'l1')
    expect(next.assignments['urn:a'].layerId).toBe('l1')
    expect(next.assignments['urn:a'].inheritsChildren).toBe(true)
    expect(next.assignments['urn:a'].assignedBy).toBe('user')
    expect(typeof next.assignments['urn:a'].assignedAt).toBe('string')
  })

  it('honours opts (logicalNodeId, inheritsChildren false, assignedBy)', () => {
    const next = assignEntities(layout(), ['urn:a'], 'l1', {
      logicalNodeId: 'ln1',
      inheritsChildren: false,
      assignedBy: 'import',
    })
    expect(next.assignments['urn:a']).toMatchObject({
      layerId: 'l1',
      logicalNodeId: 'ln1',
      inheritsChildren: false,
      assignedBy: 'import',
    })
  })

  it('assigns multiple urns to the same layer', () => {
    const next = assignEntities(layout(), ['urn:a', 'urn:b'], 'l1')
    expect(next.assignments['urn:a'].layerId).toBe('l1')
    expect(next.assignments['urn:b'].layerId).toBe('l1')
  })

  it('clearDescendants deletes explicit entries so they inherit', () => {
    const before = layout({
      'urn:child': { layerId: 'other', inheritsChildren: true },
    })
    const next = assignEntities(before, ['urn:parent'], 'l1', { clearDescendants: ['urn:child'] })
    expect(next.assignments['urn:parent'].layerId).toBe('l1')
    expect(next.assignments['urn:child']).toBeUndefined()
  })

  it('does not mutate the input layout or its assignments', () => {
    const before = layout({ 'urn:x': { layerId: 'l1', inheritsChildren: true } })
    const snapshot = JSON.stringify(before)
    assignEntities(before, ['urn:a'], 'l1', { clearDescendants: ['urn:x'] })
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('assignmentMutations — unassignEntities', () => {
  it('removes explicit entries; leaves others', () => {
    const before = layout({
      'urn:a': { layerId: 'l1', inheritsChildren: true },
      'urn:b': { layerId: 'l1', inheritsChildren: true },
    })
    const next = unassignEntities(before, ['urn:a'])
    expect(next.assignments['urn:a']).toBeUndefined()
    expect(next.assignments['urn:b'].layerId).toBe('l1')
  })

  it('is a no-op (new object) for an unassigned urn', () => {
    const before = layout({ 'urn:b': { layerId: 'l1', inheritsChildren: true } })
    const next = unassignEntities(before, ['urn:missing'])
    expect(next.assignments['urn:b'].layerId).toBe('l1')
    expect(before.assignments['urn:missing']).toBeUndefined()
  })
})

describe('assignmentMutations — remapAssignmentUrn', () => {
  it('moves an existing entry from old to new key', () => {
    const before = layout({ 'urn:staged:a': { layerId: 'l1', inheritsChildren: true, assignedBy: 'user' } })
    const next = remapAssignmentUrn(before, 'urn:staged:a', 'urn:real:a')
    expect(next.assignments['urn:staged:a']).toBeUndefined()
    expect(next.assignments['urn:real:a']).toMatchObject({ layerId: 'l1', assignedBy: 'user' })
  })

  it('is a no-op when the old key is not assigned (returns input unchanged)', () => {
    const before = layout({ 'urn:other': { layerId: 'l1', inheritsChildren: true } })
    const next = remapAssignmentUrn(before, 'urn:missing', 'urn:real')
    expect(next).toBe(before)
  })

  it('is a no-op when old === new', () => {
    const before = layout({ 'urn:a': { layerId: 'l1', inheritsChildren: true } })
    expect(remapAssignmentUrn(before, 'urn:a', 'urn:a')).toBe(before)
  })
})

// Documents the exact sequence of canonical-layout snapshots ContextViewCanvas produces for
// "create into A -> move to B -> undo" (Task 3b §4). Since Task 3, `handleAssignToLayer` snapshots
// `before = currentLayout()` FRESH at move time and stages `discard: () => persistReferenceLayout(before)`
// — so once the create path (Task 3b §3) writes a canonical entry for the temp urn at CREATE time,
// that entry IS what `before` captures on a later move, and undo (which runs the staged change's
// `discard`) restores it. No node-property fallback is involved. The ContextViewCanvas wiring itself
// isn't unit-testable without mounting the whole canvas (same constraint noted in the Task 3 fix-round
// for the instanceAssignment-shadow fix) — this test exercises the pure mutations that back it, and the
// wiring was verified by tracing handleAssignToLayer/onEntityStaged/onRowStaged/discard by hand.
describe('assignmentMutations — create -> move -> undo (documents the ContextViewCanvas discard fallback, Task 3b §4)', () => {
  it('a session-created root keeps its CREATE-time layer after a later move is undone', () => {
    // 1. onEntityStaged/onRowStaged (create into layer A) writes a canonical entry keyed by the temp urn.
    const afterCreate = assignEntities(layout(), ['urn:staged:x'], 'A')
    expect(afterCreate.assignments['urn:staged:x'].layerId).toBe('A')

    // 2. handleAssignToLayer (move to B) snapshots `before` FRESH — it sees the create-time entry, and
    //    assignEntities returns a NEW object, so `before` stays untouched by the move.
    const before = afterCreate
    const after = assignEntities(before, ['urn:staged:x'], 'B')
    expect(after.assignments['urn:staged:x'].layerId).toBe('B')
    expect(before.assignments['urn:staged:x'].layerId).toBe('A')

    // 3. Undo runs the staged assign_layer change's `discard: () => persistReferenceLayout(before)`.
    const afterUndo = before
    expect(afterUndo.assignments['urn:staged:x'].layerId).toBe('A')
  })

  it('remap on save re-keys the CURRENT (possibly moved) entry temp->real without losing its layer', () => {
    const afterCreate = assignEntities(layout(), ['urn:staged:x'], 'A')
    const afterMove = assignEntities(afterCreate, ['urn:staged:x'], 'B')

    const remapped = remapAssignmentUrn(afterMove, 'urn:staged:x', 'urn:real:x')
    expect(remapped.assignments['urn:staged:x']).toBeUndefined()
    expect(remapped.assignments['urn:real:x'].layerId).toBe('B')
  })
})

describe('assignmentMutations — pruneTempAssignments', () => {
  it('isTempUrn only matches the urn:staged: prefix', () => {
    expect(isTempUrn('urn:staged:Table:abc')).toBe(true)
    expect(isTempUrn('urn:real:Table:abc')).toBe(false)
    expect(isTempUrn('domain:finance')).toBe(false)
  })

  it('drops temp-urn keys and keeps real ones', () => {
    const next = pruneTempAssignments(layout({
      'urn:staged:Object:dead': { layerId: 'l1', inheritsChildren: true },
      'urn:real:Object:live': { layerId: 'l1', inheritsChildren: true },
    }))
    expect(Object.keys(next.assignments)).toEqual(['urn:real:Object:live'])
  })

  it('is a no-op (same reference) when there are no temp urns', () => {
    const before = layout({ 'urn:real:x': { layerId: 'l1', inheritsChildren: true } })
    expect(pruneTempAssignments(before)).toBe(before)
  })

  it('preserves layers and does not mutate the input', () => {
    const before = layout({ 'urn:staged:X:1': { layerId: 'l1', inheritsChildren: true } })
    const next = pruneTempAssignments(before)
    expect(next.layers).toBe(before.layers)
    expect(before.assignments['urn:staged:X:1']).toBeDefined() // input untouched
    expect(next.assignments['urn:staged:X:1']).toBeUndefined()
  })
})

describe('assignmentMutations — orderKey (custom node ordering)', () => {
  const entry = (layerId: string, orderKey?: string): LayerAssignmentEntry => ({
    layerId,
    inheritsChildren: true,
    ...(orderKey ? { orderKey } : {}),
  })

  it('stamps an explicit opts.orderKey', () => {
    const next = assignEntities(layout(), ['urn:a'], 'l1', { orderKey: 'a1' })
    expect(next.assignments['urn:a'].orderKey).toBe('a1')
  })

  it('carries the existing orderKey forward on a SAME-layer re-assign', () => {
    const next = assignEntities(layout({ 'urn:a': entry('l1', 'a3') }), ['urn:a'], 'l1', {
      logicalNodeId: 'ln1',
    })
    expect(next.assignments['urn:a'].orderKey).toBe('a3')
  })

  it('drops the orderKey on a CROSS-layer move (keys order within one layer only)', () => {
    const next = assignEntities(layout({ 'urn:a': entry('l2', 'a3') }), ['urn:a'], 'l1')
    expect(next.assignments['urn:a'].orderKey).toBeUndefined()
  })

  it('orderKey survives temp→real urn remap (created node keeps its slot after Save)', () => {
    const before = layout({ 'urn:staged:table:x': entry('l1', 'a2') })
    const next = remapAssignmentUrn(before, 'urn:staged:table:x', 'urn:real:table:x')
    expect(next.assignments['urn:real:table:x'].orderKey).toBe('a2')
    expect(next.assignments['urn:staged:table:x']).toBeUndefined()
  })

  it('setAssignmentOrderKey sets, clears, and no-ops on missing entries', () => {
    const base = layout({ 'urn:a': entry('l1') })
    const withKey = setAssignmentOrderKey(base, 'urn:a', 'a5')
    expect(withKey.assignments['urn:a'].orderKey).toBe('a5')
    const cleared = setAssignmentOrderKey(withKey, 'urn:a', null)
    expect(cleared.assignments['urn:a'].orderKey).toBeUndefined()
    expect(setAssignmentOrderKey(base, 'urn:missing', 'a1')).toBe(base)
  })

  it('lastOrderKeyInLayer returns the layer-scoped ordinal max (null when unkeyed)', () => {
    const l = layout({
      'urn:a': entry('l1', 'a1'),
      'urn:b': entry('l1', 'a3'),
      'urn:c': entry('l2', 'a9'),
      'urn:d': entry('l1'),
    })
    expect(lastOrderKeyInLayer(l, 'l1')).toBe('a3')
    expect(lastOrderKeyInLayer(l, 'l3')).toBe(null)
  })

  it('mutations preserve the defaultNodeSortMode side-field', () => {
    const withDefault: NormalizedReferenceLayout = { ...layout(), defaultNodeSortMode: 'alpha-desc' }
    expect(assignEntities(withDefault, ['urn:a'], 'l1').defaultNodeSortMode).toBe('alpha-desc')
    expect(unassignEntities(assignEntities(withDefault, ['urn:a'], 'l1'), ['urn:a']).defaultNodeSortMode).toBe('alpha-desc')
    const staged = assignEntities(withDefault, ['urn:staged:t:x'], 'l1')
    expect(pruneTempAssignments(staged).defaultNodeSortMode).toBe('alpha-desc')
  })
})

describe('assignmentMutations — keyForInsertion (drag-reorder neighbor walk)', () => {
  const entry = (layerId: string, orderKey?: string): LayerAssignmentEntry => ({
    layerId,
    inheritsChildren: true,
    ...(orderKey ? { orderKey } : {}),
  })
  const layoutWith = (assignments: Record<string, LayerAssignmentEntry>): NormalizedReferenceLayout => ({
    layers: [{ id: 'l1', name: 'L1', order: 0, entityTypes: [], nodeSortMode: 'custom' }],
    assignments,
  })

  it('mints strictly between two keyed neighbors', () => {
    const l = layoutWith({ a: entry('l1', 'a1'), b: entry('l1', 'a2') })
    const key = keyForInsertion(l, 'l1', ['a', 'b'], 1)
    expect(key && key > 'a1' && key < 'a2').toBe(true)
  })

  it('walks OUTWARD past unkeyed neighbors instead of minting the smallest key', () => {
    // Visual order: keyed(a1) · unkeyed · [drop here] · unkeyed · keyed(a2)
    const l = layoutWith({ a: entry('l1', 'a1'), d: entry('l1', 'a2') })
    const key = keyForInsertion(l, 'l1', ['a', 'b', 'c', 'd'], 2)
    expect(key && key > 'a1' && key < 'a2').toBe(true)
  })

  it('appends after the layer max when BOTH sides are unkeyed (trailing region drop)', () => {
    const l = layoutWith({ a: entry('l1', 'a3') })
    const key = keyForInsertion(l, 'l1', ['b', 'c'], 1) // between two unkeyed roots
    expect(key && key > 'a3').toBe(true)
  })

  it('prepends before the first keyed root at insertIdx 0', () => {
    const l = layoutWith({ a: entry('l1', 'a1') })
    const key = keyForInsertion(l, 'l1', ['a'], 0)
    expect(key && key < 'a1').toBe(true)
  })

  it('returns null (refuses) on malformed neighbor keys', () => {
    const l = layoutWith({ a: entry('l1', '!!bad'), b: entry('l1', 'a2') })
    expect(keyForInsertion(l, 'l1', ['a', 'b'], 1)).toBe(null)
  })
})

describe('assignmentMutations — keysForInsertion (multi-select block reorder)', () => {
  const entry = (layerId: string, orderKey?: string): LayerAssignmentEntry => ({
    layerId,
    inheritsChildren: true,
    ...(orderKey ? { orderKey } : {}),
  })
  const layoutWith = (assignments: Record<string, LayerAssignmentEntry>): NormalizedReferenceLayout => ({
    layers: [{ id: 'l1', name: 'L1', order: 0, entityTypes: [], nodeSortMode: 'custom' }],
    assignments,
  })

  it('mints N strictly increasing keys inside the gap', () => {
    const l = layoutWith({ a: entry('l1', 'a1'), b: entry('l1', 'a2') })
    const keys = keysForInsertion(l, 'l1', ['a', 'b'], 1, 3)
    expect(keys).toHaveLength(3)
    let prev = 'a1'
    for (const k of keys!) {
      expect(k > prev && k < 'a2').toBe(true)
      prev = k
    }
  })

  it('block append after the layer max when both sides are unkeyed', () => {
    const l = layoutWith({ a: entry('l1', 'a5') })
    const keys = keysForInsertion(l, 'l1', ['x', 'y'], 1, 2)
    expect(keys).toHaveLength(2)
    expect(keys![0] > 'a5' && keys![1] > keys![0]).toBe(true)
  })
})

describe('assignmentMutations — ensureSiblingOrderKeys (hierarchical seeding)', () => {
  const entry = (layerId: string, orderKey?: string): LayerAssignmentEntry => ({
    layerId,
    inheritsChildren: true,
    ...(orderKey ? { orderKey } : {}),
  })
  const layoutWith = (assignments: Record<string, LayerAssignmentEntry>): NormalizedReferenceLayout => ({
    layers: [{ id: 'l1', name: 'L1', order: 0, entityTypes: [], nodeSortMode: 'custom' }],
    assignments,
  })

  it('seeds unkeyed siblings in visual order, CREATING entries for entry-less children', () => {
    // A, B, C are children with NO assignment entries (they inherit their layer).
    const out = ensureSiblingOrderKeys(layoutWith({}), 'l1', ['A', 'B', 'C'])
    const ka = out.assignments['A'].orderKey
    const kb = out.assignments['B'].orderKey
    const kc = out.assignments['C'].orderKey
    expect(ka && kb && kc && ka < kb && kb < kc).toBe(true) // key order == visual order
    // Created entries carry the layer + are inert orderKey carriers.
    expect(out.assignments['A'].layerId).toBe('l1')
    expect(out.assignments['A'].inheritsChildren).toBe(true)
  })

  it('is a no-op (same layout) when every sibling is already keyed', () => {
    const input = layoutWith({ A: entry('l1', 'a0'), B: entry('l1', 'a1') })
    expect(ensureSiblingOrderKeys(input, 'l1', ['A', 'B'])).toBe(input)
  })

  it('appends unkeyed siblings after the set max, preserving existing keys', () => {
    const input = layoutWith({ A: entry('l1', 'a1'), B: entry('l1') })
    const out = ensureSiblingOrderKeys(input, 'l1', ['A', 'B'])
    expect(out.assignments['A'].orderKey).toBe('a1') // untouched
    expect((out.assignments['B'].orderKey ?? '') > 'a1').toBe(true)
  })

  it('scopes the max to THIS sibling set (independent child/root key sequences)', () => {
    // A root set already keyed to a9; a fresh child set should start low, not after a9.
    const input = layoutWith({ root: entry('l1', 'a9'), childA: entry('l1'), childB: entry('l1') })
    const out = ensureSiblingOrderKeys(input, 'l1', ['childA', 'childB'])
    expect((out.assignments['childA'].orderKey ?? 'z') < 'a9').toBe(true)
  })
})

describe('auto-adopt custom order on manual reorder (handleReorderNode composition)', () => {
  // Mirrors the pure pipeline handleReorderNode runs when a user drags in a
  // NON-custom layer: flip to custom (seed roots from visual order) → seed the
  // sibling set → mint a key at the drop position. Proves reorder works
  // without the user first picking a sort mode.
  const assignE = (layerId: string, orderKey?: string): LayerAssignmentEntry => ({
    layerId, inheritsChildren: true, ...(orderKey ? { orderKey } : {}),
  })

  it('flips an alpha layer to custom and places B before A', () => {
    // Alpha layer: visual order A, B (both keyless).
    let layout: NormalizedReferenceLayout = {
      layers: [{ id: 'l1', name: 'L1', order: 0, entityTypes: [] }], // no nodeSortMode
      assignments: { A: assignE('l1'), B: assignE('l1') },
    }
    const visualRoots = ['A', 'B']

    // 1. auto-adopt custom, seeding roots in visual order
    layout = setLayerNodeSortMode(layout, 'l1', 'custom', visualRoots)
    expect(layout.layers[0].nodeSortMode).toBe('custom')
    // 2. seed the sibling set (already keyed here — no-op) + mint B before A
    layout = ensureSiblingOrderKeys(layout, 'l1', visualRoots)
    const order = ['A'] // siblings minus the dragged B
    const keys = keysForInsertion(layout, 'l1', order, 0, 1) // insert before A
    expect(keys).not.toBeNull()
    layout = setAssignmentOrderKey(layout, 'B', keys![0])

    // B now sorts before A.
    expect(layout.assignments['B'].orderKey! < layout.assignments['A'].orderKey!).toBe(true)
  })
})
