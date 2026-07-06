import { describe, it, expect } from 'vitest'
import {
  assignEntities,
  unassignEntities,
  remapAssignmentUrn,
  checkAssignmentConflict,
} from '../assignmentMutations'
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

describe('assignmentMutations — checkAssignmentConflict', () => {
  const parentMap = new Map<string, string>([
    ['child', 'parent'],
    ['grandchild', 'child'],
  ])

  it('blocks assigning a child to a different layer than its parent (containment_locked)', () => {
    const assignments = { parent: { layerId: 'A', inheritsChildren: true } as LayerAssignmentEntry }
    const conflict = checkAssignmentConflict(parentMap, assignments, 'child', 'B')
    expect(conflict?.type).toBe('containment_locked')
    expect(conflict?.conflictingEntityId).toBe('parent')
    expect(conflict?.conflictingLayerId).toBe('A')
  })

  it('allows assigning a child to the SAME layer as its parent', () => {
    const assignments = { parent: { layerId: 'A', inheritsChildren: true } as LayerAssignmentEntry }
    expect(checkAssignmentConflict(parentMap, assignments, 'child', 'A')).toBeNull()
  })

  it('walks up to the nearest explicitly-assigned ancestor (grandparent)', () => {
    const assignments = { parent: { layerId: 'A', inheritsChildren: true } as LayerAssignmentEntry }
    const conflict = checkAssignmentConflict(parentMap, assignments, 'grandchild', 'B')
    expect(conflict?.type).toBe('containment_locked')
    expect(conflict?.conflictingEntityId).toBe('parent')
  })

  it('returns null when no ancestor has an explicit assignment', () => {
    expect(checkAssignmentConflict(parentMap, {}, 'child', 'B')).toBeNull()
  })

  it('returns null for a root node (no parent)', () => {
    const assignments = { root: { layerId: 'A', inheritsChildren: true } as LayerAssignmentEntry }
    expect(checkAssignmentConflict(parentMap, assignments, 'root', 'B')).toBeNull()
  })
})
