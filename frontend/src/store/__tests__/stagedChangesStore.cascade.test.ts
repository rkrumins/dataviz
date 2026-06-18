/**
 * Discarding a staged parent entity must cascade to its staged children (and their
 * descendants), matched by the temp-urn → after.parentUrn linkage. Otherwise a child
 * would be orphaned (its parent never saved) and surface at the top level — the same
 * class of "flattened hierarchy" the collapse fix addresses, but via discard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useStagedChangesStore } from '../stagedChangesStore'

const reset = () =>
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })

const createEntity = (tempUrn: string, parentUrn: string | null, discard?: () => void) => ({
  type: 'create_entity' as const,
  targetId: tempUrn,
  targetUrn: tempUrn,
  after: { entityType: 't', displayName: tempUrn, parentUrn: parentUrn ?? undefined },
  summary: `create ${tempUrn}`,
  discard,
})

const ids = () => useStagedChangesStore.getState().changes.map((c) => c.targetUrn)

describe('stagedChangesStore cascade discard', () => {
  beforeEach(reset)

  it('discarding a parent also discards its staged children and grandchildren', () => {
    const s = useStagedChangesStore.getState()
    const dP = vi.fn(); const dC = vi.fn(); const dG = vi.fn()
    s.stage(createEntity('urn:staged:P', null, dP))
    s.stage(createEntity('urn:staged:C', 'urn:staged:P', dC))
    s.stage(createEntity('urn:staged:G', 'urn:staged:C', dG))

    const parentChangeId = useStagedChangesStore.getState().changes[0].id
    s.discard(parentChangeId)

    expect(ids()).toEqual([])              // whole subtree gone
    expect(dP).toHaveBeenCalledTimes(1)
    expect(dC).toHaveBeenCalledTimes(1)
    expect(dG).toHaveBeenCalledTimes(1)
  })

  it('discarding a child leaves the parent and siblings intact', () => {
    const s = useStagedChangesStore.getState()
    s.stage(createEntity('urn:staged:P', null))
    s.stage(createEntity('urn:staged:C1', 'urn:staged:P'))
    s.stage(createEntity('urn:staged:C2', 'urn:staged:P'))

    const c1 = useStagedChangesStore.getState().changes.find((c) => c.targetUrn === 'urn:staged:C1')!
    s.discard(c1.id)

    expect(ids().sort()).toEqual(['urn:staged:C2', 'urn:staged:P'])
  })

  it('runs discard hooks leaf-first (child before parent)', () => {
    const s = useStagedChangesStore.getState()
    const order: string[] = []
    s.stage(createEntity('urn:staged:P', null, () => order.push('P')))
    s.stage(createEntity('urn:staged:C', 'urn:staged:P', () => order.push('C')))

    s.discard(useStagedChangesStore.getState().changes[0].id)
    expect(order).toEqual(['C', 'P'])
  })
})
