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
