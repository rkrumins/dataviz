/**
 * "N deleted inside": nothing where no deletion under a row is hidden; otherwise how many, and
 * choosing it draws them — the ones not drawn yet, up to 200 — and opens the row.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'
import { DeletedInsideMark } from '../DeletedInsideMark'
import { DELETED_INSIDE_DRAWN } from '../deletedInside'

const branch = { source: 'branch', branchId: 'd1' } as const
const deletedUnderDb = (n: number): GraphChange[] => Array.from({ length: n }, (_, i): GraphChange[] => [
  { entityId: `urn:c${i}`, kind: 'node', status: 'removed', label: `c${i}`, origin: branch, before: { displayName: `c${i}` } },
  { entityId: `k${i}`, kind: 'edge', status: 'removed', label: `k${i}`, origin: branch,
    before: { sourceEntityId: 'urn:db', targetEntityId: `urn:c${i}`, edgeType: 'CONTAINS' } },
]).flat()
const onOpen = vi.fn()

beforeEach(() => {
  onOpen.mockReset()
  useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'] } } as never)
  useBranchStore.setState({ activeChangeSet: buildChangeSet(deletedUnderDb(250)) } as never)
  useCanvasStore.getState().setNodesAndEdges([], [])
  // c0 is drawn already; the other 249 are not.
  useCanvasStore.getState().addNodes([{ id: 'urn:c0', type: 'generic', position: { x: 0, y: 0 }, data: { urn: 'urn:c0', isGhost: true } } as never])
  useCanvasStore.setState({ ghostPins: [], deletedHidden: new Map([['urn:db', 249]]) })
})

describe('DeletedInsideMark', () => {
  it('says nothing where no deletion under the row is hidden', () => {
    const { container } = render(<DeletedInsideMark urn="urn:other" onOpen={onOpen} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws the hidden ones, up to 200, and opens the row', () => {
    render(<DeletedInsideMark urn="urn:db" onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: 'Draw 200 of 249 deleted inside' }))

    const pins = useCanvasStore.getState().ghostPins
    expect(pins).toHaveLength(DELETED_INSIDE_DRAWN)
    expect(pins).not.toContain('urn:c0')                                  // already drawn
    expect(pins[0]).toBe('urn:c1')
    expect(onOpen).toHaveBeenCalled()
  })
})
