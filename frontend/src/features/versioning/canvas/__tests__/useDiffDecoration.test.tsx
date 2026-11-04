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
import { buildChangeSet, type GraphChange } from '../../model/changeModel'

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

  it('costs a node a lookup, not the change set: 300 rows over 100,000 changes', () => {
    // Each row used to build its own map of every change (30M inserts here). One index serves all.
    const changes: GraphChange[] = Array.from({ length: 100_000 }, (_, i) => ({
      entityId: `urn:${i}`, kind: 'node', status: i % 3 === 0 ? 'added' : 'modified', label: '',
      origin: { source: 'branch', branchId: 'b' },
    }))
    act(() => useBranchStore.setState({ activeChangeSet: buildChangeSet(changes) }))
    act(() => useStagedChangesStore.setState({ changes: [staged('urn:7', 'delete_entity')] }))
    const started = performance.now()
    const rows = Array.from({ length: 300 }, () => renderHook(() => useEntityChangeDecoration()))
    expect(performance.now() - started).toBeLessThan(1500)
    expect(rows[0].result.current.for('urn:3')).toEqual({ state: 'committed', status: 'added' })
    expect(rows[299].result.current.for('urn:4')).toEqual({ state: 'committed', status: 'modified' })
    expect(rows[150].result.current.for('urn:7')).toEqual({ state: 'staged', status: 'removed' })
    rows.forEach((r) => r.unmount())
  })
})

describe('useEntityChangeDecoration, entity ids that are not urns', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [] })
    useBranchStore.setState({ activeChangeSet: null, committedDiffHidden: false })
  })

  it('rings a committed node under the urn the canvas names it by', () => {
    const c = { entityId: 'ent_A', urn: 'urn:A', kind: 'node' as const, status: 'added' as const, label: 'A',
      origin: { source: 'branch' as const, branchId: 'b' } }
    act(() => useBranchStore.setState({ activeChangeSet: buildChangeSet([c]) }))
    const { result } = renderHook(() => useEntityChangeDecoration())
    expect(result.current.for('urn:A')).toEqual({ state: 'committed', status: 'added' })
    expect(result.current.for('ent_A')).toBeUndefined()
  })
})
