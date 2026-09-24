/**
 * The View Wizard's group editor runs the canvas's own group operations on the whole layout.
 * Two bugs of its old private copy are pinned here: moving a group into its own descendant DELETED
 * it (with everything inside), and deleting a group left the canonical assignments pointing at it.
 */
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useLogicalNodes } from '../useLogicalNodes'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'

const layout = (): NormalizedReferenceLayout => ({
  layers: [{
    id: 'L', name: 'Apps', color: '#000', order: 0, entityTypes: [],
    logicalNodes: [{ id: 'a', name: 'A', type: 'group', children: [{ id: 'a1', name: 'A1', type: 'group' }] },
                   { id: 'b', name: 'B', type: 'group' }],
  } as never],
  assignments: { x: { layerId: 'L', logicalNodeId: 'a1' }, y: { layerId: 'L', logicalNodeId: 'b' } } as never,
})

function setup() {
  const commit = vi.fn()
  const quiet = vi.fn()
  const { result } = renderHook(() => useLogicalNodes(layout(), commit, undefined, quiet))
  return { hook: result.current, commit, quiet }
}
const groupsOf = (l: NormalizedReferenceLayout) => l.layers[0].logicalNodes

describe('View Wizard groups = the canvas group operations', () => {
  it('refuses to move a group into its own descendant — nothing is lost', () => {
    const { hook, commit } = setup()
    hook.moveNode('L', 'a', 'a1')
    expect(commit).not.toHaveBeenCalled()
  })

  it('nests a group, and moves it back to the top of the layer', () => {
    const { hook, commit } = setup()
    hook.moveNode('L', 'b', 'a1')
    expect(groupsOf(commit.mock.calls[0][0])![0].children![0].children!.map((g: { id: string }) => g.id)).toEqual(['b'])
  })

  it('deleting a group releases its members in the CANONICAL assignments (they stay in the layer)', () => {
    const { hook, commit } = setup()
    hook.deleteNode('L', 'a')                       // a and a1 go
    const next = commit.mock.calls[0][0] as NormalizedReferenceLayout
    expect(groupsOf(next)!.map(g => g.id)).toEqual(['b'])
    expect(next.assignments.x).toEqual({ layerId: 'L' })
    expect(next.assignments.y).toEqual({ layerId: 'L', logicalNodeId: 'b' })
  })

  it('ungroups (contents move up a level) and moves everything into another group', () => {
    const a = setup()
    a.hook.ungroupNode('L', 'a1')                   // x moves up into A
    expect((a.commit.mock.calls[0][0] as NormalizedReferenceLayout).assignments.x).toEqual({ layerId: 'L', logicalNodeId: 'a' })
    const b = setup()
    b.hook.moveContents('L', 'a', 'b')               // A1 moves under B
    expect(groupsOf(b.commit.mock.calls[0][0])!.find(g => g.id === 'b')!.children!.map(g => g.id)).toEqual(['a1'])
  })

  it('collapsing a group is visual — applied without an undo entry', () => {
    const { hook, commit, quiet } = setup()
    hook.toggleCollapse('L', 'a')
    expect(commit).not.toHaveBeenCalled()
    expect(groupsOf(quiet.mock.calls[0][0])![0].collapsed).toBe(true)
  })

  it('paths read like the canvas', () => {
    const { hook } = setup()
    expect(hook.nodePathLabel('L', 'a1')).toBe('A › A1')
  })

  it('moves a group to another layer; its members go along', () => {
    const commit = vi.fn()
    const two: NormalizedReferenceLayout = { ...layout(), layers: [...layout().layers, { id: 'M', name: 'Layer 3', color: '#000', order: 1, entityTypes: [] } as never] }
    const { result } = renderHook(() => useLogicalNodes(two, commit))
    expect(result.current.layerChoices().map(l => l.layerName)).toEqual(['Apps', 'Layer 3'])
    result.current.moveNodeToLayer('L', 'a', 'M')
    const next = commit.mock.calls[0][0] as NormalizedReferenceLayout
    expect(next.layers[0].logicalNodes!.map(g => g.id)).toEqual(['b'])
    expect(next.layers[1].logicalNodes!.map(g => g.id)).toEqual(['a'])
    expect(next.assignments.x).toEqual({ layerId: 'M', logicalNodeId: 'a1' })   // inside a1, inside a
    expect(next.assignments.y).toEqual({ layerId: 'L', logicalNodeId: 'b' })
  })
})
