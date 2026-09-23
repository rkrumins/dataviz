import { describe, expect, it } from 'vitest'
import { addGroup, groupSubtreeIds, removeGroup, renameGroup } from '../layerMutations'
import { releaseGroupMembers } from '../assignmentMutations'
import type { ViewLayerConfig } from '@/types/schema'

const layers = (): ViewLayerConfig[] => [
  { id: 'L1', name: 'Domains', color: '#000', order: 0, entityTypes: [] } as ViewLayerConfig,
  { id: 'L3', name: 'Layer 3', color: '#000', order: 1, entityTypes: [] } as ViewLayerConfig,
]
const g = (id: string, name = id) => ({ id, name, type: 'group' as const })

describe('groups on a layer (view-only containers)', () => {
  it('adds a group, and a group inside a group', () => {
    let ls = addGroup(layers(), 'L3', g('crit', 'Critical'))
    ls = addGroup(ls, 'L3', g('tier1', 'Tier 1'), 'crit')
    const tree = ls.find((l) => l.id === 'L3')!.logicalNodes!
    expect(tree.map((x) => x.name)).toEqual(['Critical'])
    expect(tree[0].children!.map((x) => x.name)).toEqual(['Tier 1'])
    expect(ls.find((l) => l.id === 'L1')!.logicalNodes).toBeUndefined()   // other layers untouched
  })

  it('renames a group at any depth', () => {
    let ls = addGroup(addGroup(layers(), 'L3', g('crit')), 'L3', g('tier1'), 'crit')
    ls = renameGroup(ls, 'L3', 'tier1', 'Gold')
    expect(ls.find((l) => l.id === 'L3')!.logicalNodes![0].children![0].name).toBe('Gold')
  })

  it('deletes a group with the groups inside it, and releases their members', () => {
    let ls = addGroup(addGroup(addGroup(layers(), 'L3', g('crit')), 'L3', g('tier1'), 'crit'), 'L3', g('other'))
    expect(groupSubtreeIds(ls, 'L3', 'crit').sort()).toEqual(['crit', 'tier1'])
    ls = removeGroup(ls, 'L3', 'crit')
    expect(ls.find((l) => l.id === 'L3')!.logicalNodes!.map((x) => x.id)).toEqual(['other'])
    const layout = {
      layers: ls,
      assignments: {
        a: { layerId: 'L3', logicalNodeId: 'tier1' }, b: { layerId: 'L3', logicalNodeId: 'other' },
      },
    } as never
    const out = releaseGroupMembers(layout, ['crit', 'tier1'])
    expect(out.assignments.a).toEqual({ layerId: 'L3' })                 // stays in the column, ungrouped
    expect(out.assignments.b).toEqual({ layerId: 'L3', logicalNodeId: 'other' })
    expect(releaseGroupMembers(out, ['nope'])).toBe(out)                 // nothing to release: same layout
  })
})

import { listGroups, moveGroup, moveGroupContents, parentGroupOf, ungroup } from '../layerMutations'
import { reassignGroupMembers } from '../assignmentMutations'

describe('managing groups: nest, move contents, ungroup', () => {
  const base = () => addGroup(addGroup(addGroup(layers(), 'L3', g('a', 'A')), 'L3', g('a1', 'A1'), 'a'), 'L3', g('b', 'B'))
  const tree = (ls: ViewLayerConfig[]) => listGroups(ls, 'L3').map((x) => x.path)

  it('lists every group with its path', () => {
    expect(tree(base())).toEqual(['A', 'A › A1', 'B'])
  })

  it('nests a group inside another, and moves it back to the top of the layer', () => {
    let ls = moveGroup(base(), 'L3', 'b', 'a1')
    expect(tree(ls)).toEqual(['A', 'A › A1', 'A › A1 › B'])
    expect(parentGroupOf(ls, 'L3', 'b')).toBe('a1')
    ls = moveGroup(ls, 'L3', 'b', null)
    expect(tree(ls)).toEqual(['A', 'A › A1', 'B'])
  })

  it('refuses to put a group inside itself or its own descendants', () => {
    const ls = base()
    expect(moveGroup(ls, 'L3', 'a', 'a1')).toBe(ls)
    expect(moveGroup(ls, 'L3', 'a', 'a')).toBe(ls)
  })

  it('ungroups: sub-groups move up a level, members go to the parent group (or the layer)', () => {
    const ls = ungroup(base(), 'L3', 'a')
    expect(tree(ls)).toEqual(['A1', 'B'])
    const layout = { layers: ls, assignments: { x: { layerId: 'L3', logicalNodeId: 'a1' }, y: { layerId: 'L3', logicalNodeId: 'b' } } } as never
    expect(reassignGroupMembers(layout, ['b'], null).assignments.y).toEqual({ layerId: 'L3' })
  })

  it('moves all contents of one group into another', () => {
    const ls = moveGroupContents(base(), 'L3', 'a', 'b')
    expect(tree(ls)).toEqual(['A', 'B', 'B › A1'])
    const layout = { layers: ls, assignments: { x: { layerId: 'L3', logicalNodeId: 'a' } } } as never
    expect(reassignGroupMembers(layout, ['a'], 'b').assignments.x).toEqual({ layerId: 'L3', logicalNodeId: 'b' })
  })
})
