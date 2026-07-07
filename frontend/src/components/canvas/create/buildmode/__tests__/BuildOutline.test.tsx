/**
 * BuildOutline — Task 3 (Enter on an empty row climbs to a new top-level
 * entity) and Task 4 (per-row type change via the shared TypePickerPopover)
 * tests.
 *
 * `useViewEntityTypes`/etc. are mocked (same `vi.hoisted` + `@/hooks/useViewSchema`
 * convention BuildGrid.test.tsx uses) because BuildOutline calls them directly
 * to compute `builderAllowedChildTypeIds`'s ontology-legal options — a made-up
 * `Layer -> Object -> Group(self-nesting) -> Attribute` fixture proves the
 * options are schema-derived, not hard-coded.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EntityTypeSchema } from '@/types/schema'
import { useBuildRowsStore } from '../buildRowsStore'
import { makeRow } from '../buildRow'

const { entityTypes, rootEntityTypes, hierarchyMap, relationshipTypes, containmentEdgeTypes } = vi.hoisted(() => {
  const et = (id: string, canContain: string[], canBeContainedBy: string[] = []) => ({
    id,
    name: id,
    pluralName: id,
    visual: { icon: 'Box', color: '#6366f1' },
    fields: [],
    behavior: {},
    hierarchy: { level: 0, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
  })
  const rt = (id: string, sourceTypes: string[], targetTypes: string[]) => ({
    id,
    name: id,
    sourceTypes,
    targetTypes,
    isContainment: true,
  })
  return {
    entityTypes: [
      et('layer', ['object']),
      et('object', ['group'], ['layer']),
      et('group', ['group', 'attribute'], ['object', 'group']),
      et('attribute', [], ['group']),
    ],
    rootEntityTypes: ['layer'],
    hierarchyMap: {},
    relationshipTypes: [
      rt('CONTAINS_OBJECT', ['layer'], ['object']),
      rt('CONTAINS_GROUP', ['object'], ['group']),
      rt('CONTAINS_SUB', ['group'], ['group', 'attribute']),
    ],
    containmentEdgeTypes: [] as string[],
  }
})

vi.mock('@/hooks/useViewSchema', () => ({
  useViewEntityTypes: () => entityTypes,
  useViewRootEntityTypes: () => rootEntityTypes,
  useViewEntityTypeHierarchyMap: () => hierarchyMap,
  useViewRelationshipTypes: () => relationshipTypes,
  useViewContainmentEdgeTypes: () => containmentEdgeTypes,
}))

import { BuildOutline } from '../BuildOutline'

const typeById = new Map<string, EntityTypeSchema>(entityTypes.map((t) => [t.id, t as unknown as EntityTypeSchema]))

describe('BuildOutline — Enter key (Task 3)', () => {
  beforeEach(() => useBuildRowsStore.getState().reset())

  it('Enter on a NON-empty row still adds a same-depth sibling (unchanged)', () => {
    useBuildRowsStore.getState().setRows([makeRow({ id: 'a', name: 'Alpha', typeId: 'layer' })])
    render(<BuildOutline rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    fireEvent.keyDown(screen.getByDisplayValue('Alpha'), { key: 'Enter' })

    const rows = useBuildRowsStore.getState().rows
    expect(rows).toHaveLength(2)
    const created = rows.find((r) => r.id !== 'a')!
    expect(created.parentId).toBeNull()
    expect(created.depth).toBe(0)
  })

  it('Enter on an EMPTY row climbs through ancestors one level at a time, then starts a new top-level row', () => {
    useBuildRowsStore.getState().setRows([
      makeRow({ id: 'root', name: 'Root', typeId: 'layer' }),
      makeRow({ id: 'mid', name: 'Mid', typeId: 'object', parentId: 'root' }),
      makeRow({ id: 'leaf', name: '', typeId: null, parentId: 'mid' }),
    ])
    const { rerender } = render(<BuildOutline rows={useBuildRowsStore.getState().rows} typeById={typeById} />)
    const getEmptyInput = () => screen.getByDisplayValue('')

    // depth 2 -> depth 1: outdents to the grandparent, no new row.
    fireEvent.keyDown(getEmptyInput(), { key: 'Enter' })
    let rows = useBuildRowsStore.getState().rows
    expect(rows).toHaveLength(3)
    let leaf = rows.find((r) => r.id === 'leaf')!
    expect(leaf.parentId).toBe('root')
    expect(leaf.depth).toBe(1)
    rerender(<BuildOutline rows={rows} typeById={typeById} />)

    // depth 1 -> depth 0: outdents to the top level, still no new row.
    fireEvent.keyDown(getEmptyInput(), { key: 'Enter' })
    rows = useBuildRowsStore.getState().rows
    expect(rows).toHaveLength(3)
    leaf = rows.find((r) => r.id === 'leaf')!
    expect(leaf.parentId).toBeNull()
    expect(leaf.depth).toBe(0)
    rerender(<BuildOutline rows={rows} typeById={typeById} />)

    // depth 0 + still empty: Enter now starts a fresh top-level row (parentId: null).
    fireEvent.keyDown(getEmptyInput(), { key: 'Enter' })
    rows = useBuildRowsStore.getState().rows
    expect(rows).toHaveLength(4)
    const created = rows.find((r) => !['root', 'mid', 'leaf'].includes(r.id))!
    expect(created.parentId).toBeNull()
    expect(created.depth).toBe(0)
  })
})

describe('BuildOutline — per-row type change (Task 4)', () => {
  beforeEach(() => useBuildRowsStore.getState().reset())

  it('offers only ontology-legal children of the row parent type, and retypes on pick', () => {
    useBuildRowsStore.getState().setRows([
      makeRow({ id: 'root', name: 'Root', typeId: 'layer' }),
      makeRow({ id: 'obj', name: 'Obj', typeId: 'object', parentId: 'root' }),
      makeRow({ id: 'g1', name: 'Group1', typeId: 'group', parentId: 'obj' }),
      makeRow({ id: 'g2', name: 'Group2', typeId: 'group', parentId: 'g1' }),
    ])
    render(<BuildOutline rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    // g2's parent (g1) is a 'group' — legal children of 'group' are group/attribute,
    // never 'layer'/'object' (which are NOT legal under a group).
    fireEvent.click(screen.getByRole('button', { name: 'Type for Group2' }))
    expect(screen.getByRole('button', { name: 'attribute' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'group' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'layer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'object' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'attribute' }))

    expect(useBuildRowsStore.getState().rows.find((r) => r.id === 'g2')?.typeId).toBe('attribute')
  })

  it('a depth-0 row offers only the legal top-level (root) types', () => {
    useBuildRowsStore.getState().setRows([makeRow({ id: 'root', name: 'Root', typeId: 'layer' })])
    render(<BuildOutline rows={useBuildRowsStore.getState().rows} typeById={typeById} />)

    fireEvent.click(screen.getByRole('button', { name: 'Type for Root' }))

    expect(screen.getByRole('button', { name: 'layer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'object' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'group' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'attribute' })).not.toBeInTheDocument()
  })
})
