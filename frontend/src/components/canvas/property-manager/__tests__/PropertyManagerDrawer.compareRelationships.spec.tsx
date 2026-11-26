/**
 * With several relationships selected on the canvas, the Property Manager's Properties tab offers to
 * compare them: "Compare the N selected relationships" opens them, as the canvas holds them, in the
 * relationship drawer — read side by side and changed together.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore, type LineageEdge } from '@/store/canvas'

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('../PropertyBrowser', () => ({ PropertyBrowser: () => <p>The view’s properties</p> }))

import { PropertyManagerDrawer } from '../PropertyManagerDrawer'

const edge = (id: string, edgeType = 'FLOWS_TO'): LineageEdge =>
  ({ id, source: `${id}-s`, target: `${id}-t`, data: { edgeType } }) as LineageEdge

function select(ids: string[]) {
  useCanvasStore.setState({
    edges: [edge('e1'), edge('e2'), edge('kids', 'CONTAINS')],
    selectedEdgeIds: ids, selectedNodeIds: [],
    drawerNodeId: null, drawerNodeIds: null, drawerEdge: null, drawerDirty: false, pendingDrawerMove: null,
    drawerHistory: { entries: [], cursor: -1 },
  } as never)
}
const openProperties = async (user: ReturnType<typeof userEvent.setup>) => {
  render(<PropertyManagerDrawer viewId="view-1" open onClose={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: 'Properties' }))
  expect(screen.getByText('The view’s properties')).toBeInTheDocument()
}

beforeEach(() => select([]))

describe('Property Manager — the selected relationships', () => {
  it('opens the ones selected in the relationship drawer, to compare and change together', async () => {
    const user = userEvent.setup()
    // A selected line the canvas holds no relationship for is not one of them.
    select(['e1', 'kids', 'bundle-a->b'])
    await openProperties(user)
    await user.click(screen.getByRole('button', { name: /Compare the 2 selected relationships/ }))
    expect(useCanvasStore.getState().drawerEdge).toMatchObject({
      kind: 'relationships',
      members: [
        { id: 'e1', source: 'e1-s', target: 'e1-t', edgeType: 'FLOWS_TO', rollup: false },
        { id: 'kids', source: 'kids-s', target: 'kids-t', edgeType: 'CONTAINS', rollup: false },
      ],
    })
  })

  it('is offered only for two or more', async () => {
    const user = userEvent.setup()
    select(['e1'])
    await openProperties(user)
    expect(screen.queryByRole('button', { name: /selected relationships/ })).toBeNull()
  })

  it('is on the Properties tab, not with the display rules', () => {
    select(['e1', 'e2'])
    render(<PropertyManagerDrawer viewId="view-1" open onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /selected relationships/ })).toBeNull()
  })
})
