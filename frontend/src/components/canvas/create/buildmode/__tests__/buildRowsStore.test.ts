import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBuildRowsStore } from '../buildRowsStore'
import { makeRow, type BuildRow } from '../buildRow'

vi.mock('@/features/versioning/model/ensureDraftOpen', () => ({
  ensureDraftOpen: async () => 'branch-1',
}))

const seedRows = (): BuildRow[] => [
  makeRow({ id: 'a', name: 'A', parentId: null }),
  makeRow({ id: 'b', name: 'B', parentId: 'a' }),
  makeRow({ id: 'c', name: 'C', parentId: 'b' }),
]

describe('buildRowsStore', () => {
  beforeEach(() => useBuildRowsStore.getState().reset())

  it('setRows replaces the working rows', () => {
    useBuildRowsStore.getState().setRows(seedRows())
    expect(useBuildRowsStore.getState().rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })

  it('addChild sets parentId and reindexes depth', () => {
    useBuildRowsStore.getState().setRows(seedRows())
    useBuildRowsStore.getState().addChild('a')
    const rows = useBuildRowsStore.getState().rows
    const added = rows.find((r) => !['a', 'b', 'c'].includes(r.id))!
    expect(added.parentId).toBe('a')
    expect(added.depth).toBe(1)
  })

  it('addSibling shares the parent of the anchor row', () => {
    useBuildRowsStore.getState().setRows(seedRows())
    useBuildRowsStore.getState().addSibling('b')
    const rows = useBuildRowsStore.getState().rows
    const added = rows.find((r) => !['a', 'b', 'c'].includes(r.id))!
    expect(added.parentId).toBe('a')
    expect(added.depth).toBe(1)
  })

  it('updateRow patches name and typeId', () => {
    useBuildRowsStore.getState().setRows(seedRows())
    useBuildRowsStore.getState().updateRow('b', { name: 'Renamed', typeId: 'dataset' })
    const row = useBuildRowsStore.getState().rows.find((r) => r.id === 'b')!
    expect(row.name).toBe('Renamed')
    expect(row.typeId).toBe('dataset')
  })

  it('removeRow drops the row and its descendants', () => {
    useBuildRowsStore.getState().setRows(seedRows())
    useBuildRowsStore.getState().removeRow('b')
    expect(useBuildRowsStore.getState().rows.map((r) => r.id)).toEqual(['a'])
  })

  it('reset empties the rows', () => {
    useBuildRowsStore.getState().setRows(seedRows())
    useBuildRowsStore.getState().reset()
    expect(useBuildRowsStore.getState().rows).toEqual([])
  })

  it('setRowLayer sets a Layer override; setting it to undefined clears it', () => {
    useBuildRowsStore.getState().setRows(seedRows())
    useBuildRowsStore.getState().setRowLayer('b', 'layer-x')
    expect(useBuildRowsStore.getState().rows.find((r) => r.id === 'b')?.layerId).toBe('layer-x')
    useBuildRowsStore.getState().setRowLayer('b', undefined)
    expect(useBuildRowsStore.getState().rows.find((r) => r.id === 'b')?.layerId).toBeUndefined()
  })

  it('duplicateRowSubtree clones the row and all its descendants with fresh ids', () => {
    useBuildRowsStore.getState().setRows(seedRows()) // a -> b -> c
    useBuildRowsStore.getState().duplicateRowSubtree('a')
    const rows = useBuildRowsStore.getState().rows
    const originalIds = new Set(['a', 'b', 'c'])
    expect(rows).toHaveLength(6)
    const clones = rows.filter((r) => !originalIds.has(r.id))
    expect(clones).toHaveLength(3)
    expect(new Set(clones.map((c) => c.id)).size).toBe(3)
    // the cloned root is a sibling of 'a' (same parentId: null); the cloned
    // chain re-threads to the CLONED parent, not the original.
    const cloneOfA = clones.find((c) => c.parentId === null)!
    const cloneOfB = clones.find((c) => c.parentId === cloneOfA.id)!
    const cloneOfC = clones.find((c) => c.parentId === cloneOfB.id)!
    expect(cloneOfC).toBeDefined()
  })
})

// Colocated here (rather than a separate test file) because Task 4's committed
// scope names exactly one new test file alongside buildRowsStore.ts +
// hierarchyBuilderStore.ts — see task-4-brief.md STRICT SCOPE.
describe('hierarchyBuilderStore surface/mode extension', () => {
  it('open() defaults surface to "rail"', async () => {
    const { useHierarchyBuilderStore } = await import('../../hierarchyBuilderStore')
    useHierarchyBuilderStore.getState().close()
    useHierarchyBuilderStore.getState().open()
    expect(useHierarchyBuilderStore.getState().isOpen).toBe(true)
    expect(useHierarchyBuilderStore.getState().surface).toBe('rail')
  })

  it('openBuild() opens with surface "build"', async () => {
    const { useHierarchyBuilderStore } = await import('../../hierarchyBuilderStore')
    useHierarchyBuilderStore.getState().close()
    useHierarchyBuilderStore.getState().openBuild()
    expect(useHierarchyBuilderStore.getState().isOpen).toBe(true)
    expect(useHierarchyBuilderStore.getState().surface).toBe('build')
  })

  it('close() resets surface back to "rail"', async () => {
    const { useHierarchyBuilderStore } = await import('../../hierarchyBuilderStore')
    useHierarchyBuilderStore.getState().openBuild()
    expect(useHierarchyBuilderStore.getState().surface).toBe('build')
    useHierarchyBuilderStore.getState().close()
    expect(useHierarchyBuilderStore.getState().surface).toBe('rail')
  })
})
