/**
 * useEntityChangeDecoration + nodeDecorationClass — the unified staged/committed decoration.
 * Pins: committed keeps the loved solid colour ring; staged builds ON TOP with a dashed halo;
 * staged takes precedence; and the committed-hide toggle hides committed while staged still shows.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useEntityChangeDecoration, nodeDecorationClass, deletedTitle, withStagedDeletions, isDeletedEdge } from '../useDiffDecoration'
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

describe('a staged entity delete takes its cascade with it', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [] })
    useBranchStore.setState({ activeChangeSet: null, committedDiffHidden: false })
  })

  const deleteWithCascade = {
    id: 'del', type: 'delete_entity', targetId: 'urn:root', targetUrn: 'urn:root', summary: 's', timestamp: 0,
    before: {
      node: { id: 'urn:root' },
      cascade: {
        nodes: [{ urn: 'urn:root', entityId: 'e-root' }, { urn: 'urn:child', entityId: 'e-child' }],
        edges: [{ entityId: 'edge-1', edgeType: 'FLOWS_TO' }],
        nodeTotal: 2, edgeTotal: 1,
      },
    },
  } as never

  it('marks every contained entity and touching link as deleted, not saved yet', () => {
    act(() => useStagedChangesStore.setState({ changes: [deleteWithCascade] }))
    const { result } = renderHook(() => useEntityChangeDecoration())
    const removed = { state: 'staged', status: 'removed' }
    expect(result.current.for('urn:child')).toEqual(removed)   // by urn, as the canvas keys rows
    expect(result.current.for('e-child')).toEqual(removed)     // and by entity id
    expect(result.current.for('edge-1')).toEqual(removed)
    expect(result.current.for('urn:other')).toBeUndefined()
  })

  it("lets a contained entity's own edit speak, and clears with the delete", () => {
    act(() => useStagedChangesStore.setState({ changes: [deleteWithCascade, {
      id: 'ren', type: 'rename_entity', targetId: 'urn:child', targetUrn: 'urn:child', summary: 's', timestamp: 0,
    } as never] }))
    const { result, rerender } = renderHook(() => useEntityChangeDecoration())
    expect(result.current.for('urn:child')).toEqual({ state: 'staged', status: 'modified' })
    act(() => useStagedChangesStore.setState({ changes: [] }))
    rerender()
    expect(result.current.for('edge-1')).toBeUndefined()
  })
})

describe('deletedTitle', () => {
  it('says which deletion a Deleted chip marks', () => {
    expect(deletedTitle({ state: 'staged', status: 'removed' })).toBe('Deleted · not saved yet')
    expect(deletedTitle({ state: 'committed', status: 'removed' })).toBe('Deleted in this draft')
    expect(deletedTitle({ state: 'committed', status: 'added' })).toBeUndefined()
    expect(deletedTitle(undefined)).toBeUndefined()
  })
})

describe('withStagedDeletions — deleted links stay drawn until saved', () => {
  const e = (id: string, data: Record<string, unknown> = {}) => ({ id, source: 'a', target: 'b', data })
  const live = [e('l1'), e('l2')]

  it('is the same array when nothing is staged', () => {
    expect(withStagedDeletions(live, [])).toBe(live)
  })

  it("marks the links an entity delete takes, and keeps a link deleted on its own from its staged copy", () => {
    const out = withStagedDeletions(live, [
      { type: 'delete_entity', before: { cascade: { nodes: [], edges: [{ entityId: 'l2' }] } } },
      { type: 'delete_edge', targetId: 'gone-a', before: { edge: e('gone-a') } },   // from the canvas
      { type: 'delete_edge', targetId: 'gone-b', before: e('gone-b') },             // from the edge panel
    ] as never)
    expect(out.map((x) => [x.id, isDeletedEdge(x)])).toEqual([
      ['l1', false], ['l2', true], ['gone-a', true], ['gone-b', true],
    ])
  })

  it('never draws a staged copy twice', () => {
    const out = withStagedDeletions(live, [{ type: 'delete_edge', targetId: 'l1', before: { edge: e('l1') } }] as never)
    expect(out.map((x) => x.id)).toEqual(['l1', 'l2'])
  })

  it('reads a ghost link as deleted too', () => {
    expect(isDeletedEdge(e('x', { isGhost: true }))).toBe(true)
    expect(isDeletedEdge(e('x', { isAggregated: true }))).toBe(false)
  })
})

describe('two revisions compared on the canvas', () => {
  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [] })
  })

  const compareSet = () => {
    const origin = { source: 'compare', fromSeq: 40, toSeq: 57 } as const
    const c = { entityId: 'urn:gone', kind: 'node', status: 'removed', label: 'gone', origin }
    return { changes: [c], byEntityId: new Map([[c.entityId, c]]), counts: {}, origin: 'compare' } as never
  }

  it("says which revisions a deletion fell between, and a draft's hide toggle never hides it", () => {
    act(() => useBranchStore.setState({ activeChangeSet: compareSet(), committedDiffHidden: true }))
    const { result } = renderHook(() => useEntityChangeDecoration())
    const d = result.current.for('urn:gone')
    expect(d).toEqual({ state: 'committed', status: 'removed', between: { fromSeq: 40, toSeq: 57 } })
    expect(deletedTitle(d)).toBe('Deleted after #40, by #57')
  })
})
