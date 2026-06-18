/**
 * remapEntityId re-keys a layer assignment from one id to another — used on Save to move a
 * newly-created entity's assignment off its temporary urn (urn:staged:…) onto the real urn the
 * backend issues. Without it the saved node resolves to no layer and disappears from the view.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useReferenceModelStore } from '../referenceModelStore'
import type { EntityAssignmentConfig } from '@/types/schema'

const assign = (entityId: string, layerId: string): EntityAssignmentConfig =>
  ({ entityId, layerId, inheritsChildren: false, priority: 1000 })

beforeEach(() => {
  useReferenceModelStore.setState({
    instanceAssignments: new Map(),
    effectiveAssignments: new Map(),
    layers: [],
  } as never)
})

describe('referenceModelStore.remapEntityId', () => {
  it('moves an instance assignment + layer entry from the temp urn to the real urn', () => {
    const s = useReferenceModelStore.getState()
    useReferenceModelStore.setState({
      instanceAssignments: new Map([['urn:staged:x', assign('urn:staged:x', 'L1')]]),
      layers: [{ id: 'L1', name: 'L1', entityAssignments: [assign('urn:staged:x', 'L1')] }],
    } as never)

    s.remapEntityId('urn:staged:x', 'urn:real:1')

    const st = useReferenceModelStore.getState()
    expect(st.instanceAssignments.has('urn:staged:x')).toBe(false)
    expect(st.instanceAssignments.get('urn:real:1')?.entityId).toBe('urn:real:1')
    expect(st.instanceAssignments.get('urn:real:1')?.layerId).toBe('L1')
    const layer = st.layers.find((l) => l.id === 'L1')
    expect(layer?.entityAssignments?.map((a) => a.entityId)).toEqual(['urn:real:1'])
  })

  it('is a no-op when nothing is assigned under the old id, or ids are equal/empty', () => {
    const s = useReferenceModelStore.getState()
    s.remapEntityId('urn:staged:absent', 'urn:real:1')
    s.remapEntityId('a', 'a')
    s.remapEntityId('', 'x')
    const st = useReferenceModelStore.getState()
    expect(st.instanceAssignments.size).toBe(0)
  })
})
