/**
 * useEntityChangeDecoration + nodeDecorationClass — the unified staged/committed decoration.
 * Pins: committed keeps the loved solid colour ring; staged builds ON TOP with a dashed halo;
 * staged takes precedence; and the committed-hide toggle hides committed while staged still shows.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useEntityChangeDecoration, nodeDecorationClass } from '../useDiffDecoration'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

describe('nodeDecorationClass', () => {
  it('committed = solid colour ring; staged = same ring + dashed halo; none = empty', () => {
    expect(nodeDecorationClass(undefined)).toBe('')

    const committed = nodeDecorationClass({ state: 'committed', status: 'added' })
    expect(committed).toContain('ring-2')
    expect(committed).toContain('emerald')           // green = create
    expect(committed).not.toContain('outline-dashed') // committed is solid only

    const staged = nodeDecorationClass({ state: 'staged', status: 'modified' })
    expect(staged).toContain('ring-2')               // keeps the colour ring (built upon)
    expect(staged).toContain('orange')               // update = orange (not amber)
    expect(staged).toContain('outline-dashed')       // adds the staged halo on top
  })
})

describe('useEntityChangeDecoration', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [] })
    useBranchStore.setState({ activeChangeSet: null, committedDiffHidden: false })
  })

  const changeSet = (entityId: string, status: 'added' | 'modified' | 'removed') => {
    const c = { entityId, kind: 'node', status, label: entityId, origin: { source: 'branch', branchId: 'b' } }
    return { changes: [c], byEntityId: new Map([[entityId, c]]), counts: {}, origin: c.origin } as never
  }
  const staged = (targetUrn: string, type: string) =>
    ({ id: targetUrn, type, targetId: targetUrn, targetUrn, summary: 's', timestamp: 0 } as never)

  it('a committed change → committed decoration', () => {
    act(() => useBranchStore.setState({ activeChangeSet: changeSet('urn:a', 'added') }))
    const { result } = renderHook(() => useEntityChangeDecoration())
    expect(result.current.for('urn:a')).toEqual({ state: 'committed', status: 'added' })
  })

  it('staged overrides committed for the same entity', () => {
    act(() => {
      useBranchStore.setState({ activeChangeSet: changeSet('urn:a', 'added') })
      useStagedChangesStore.setState({ changes: [staged('urn:a', 'rename_entity')] })
    })
    const { result } = renderHook(() => useEntityChangeDecoration())
    expect(result.current.for('urn:a')).toEqual({ state: 'staged', status: 'modified' })
  })

  it('committedDiffHidden hides committed, but staged still shows', () => {
    act(() => {
      useBranchStore.setState({ activeChangeSet: changeSet('urn:c', 'added'), committedDiffHidden: true })
      useStagedChangesStore.setState({ changes: [staged('urn:s', 'create_entity')] })
    })
    const { result } = renderHook(() => useEntityChangeDecoration())
    expect(result.current.for('urn:c')).toBeUndefined()                         // committed hidden
    expect(result.current.for('urn:s')).toEqual({ state: 'staged', status: 'added' }) // staged stays
  })
})
