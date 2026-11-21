/**
 * PublishForm — a publish refused because values break the fields their entity types define says
 * so, entity by entity: its name, its type, what is wrong — and the way to it: an entity on the
 * canvas opens in the drawer, one that isn't offers its id to find it by. Past the values it lists,
 * it counts them all, field by field. Nothing was published.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { FieldViolationError, type FieldViolation } from '@/services/versioningApiService'

const publishMutate = vi.fn()
vi.mock('../../hooks/useVersioning', () => ({
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
  useDataSourceDraftsPolicy: () => ({ data: { effective: { selfMerge: true } } }),
}))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToMain: vi.fn() }),
}))
vi.mock('@/store/publishReceiptStore', () => ({
  usePublishReceiptStore: (sel: (s: unknown) => unknown) => sel({ setReceipt: vi.fn() }),
}))

import { CommitDialog } from '../CommitDialog'
import { buildChangeSet } from '../../model/changeModel'

const changeSet = buildChangeSet([
  { entityId: 'e1', kind: 'node', status: 'added', label: 'Orders', origin: { source: 'committed' } },
] as never)

const violations: FieldViolation[] = [
  { entity_id: 'e1', kind: 'node', type: 'Table', name: 'Orders', urn: 'urn:orders', rule: 'field_not_allowed',
    field: 'tier', fieldName: 'Tier', value: 'bronze', reason: "Tier must be one of 'gold', 'silver' — 'bronze' isn't." },
  { entity_id: 'e9', kind: 'node', type: 'Table', name: 'Returns', urn: 'urn:returns', rule: 'field_required',
    field: 'owner', fieldName: 'Owner', value: null, reason: 'Owner is required for a new Table.' },
]

beforeEach(() => {
  publishMutate.mockReset()
  publishMutate.mockImplementation((_vars, { onError }) => onError(new FieldViolationError(violations, 1214, [
    { entityType: 'Table', field: 'owner', fieldName: 'Owner', rule: 'field_required', count: 1204 },
    { entityType: 'Table', field: 'tier', fieldName: 'Tier', rule: 'field_not_allowed', count: 10 },
  ])))
  useCanvasStore.setState({
    nodes: [{ id: 'urn:orders', type: 'generic', position: { x: 0, y: 0 }, data: { urn: 'urn:orders', label: 'Orders', type: 'Table' } }],
    edges: [], drawerNodeId: null, drawerNodeIds: null, drawerEdge: null,
  } as never)
})

describe('PublishForm — a publish refused by field rules', () => {
  it('lists each value to change, opens one on the canvas, and offers the id of one that isn’t', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <MemoryRouter>
        <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1" changeSet={changeSet} onClose={onClose} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: /publish now/i }))

    expect(screen.getByText(/Nothing was published — 1,214 values break the fields their entity types define/)).toBeInTheDocument()
    const counts = within(screen.getByRole('list', { name: 'Values to change by field' })).getAllByRole('listitem')
    expect(counts.map((c) => c.textContent)).toEqual(['Table · Owner: 1,204 missing', 'Table · Tier: 10 not allowed'])
    const list = screen.getByRole('list', { name: 'Values to change' })
    const [orders, returns] = within(list).getAllByRole('listitem')
    expect(orders).toHaveTextContent("Orders · Table · Tier must be one of 'gold', 'silver' — 'bronze' isn't.")
    expect(screen.getByText('…and 1,212 more.')).toBeInTheDocument()
    expect(within(returns).getByRole('button', { name: 'Copy the id of Returns' })).toBeInTheDocument()

    await user.click(within(orders).getByRole('button', { name: 'Open Orders' }))
    expect(onClose).toHaveBeenCalled()
    expect(useCanvasStore.getState().drawerNodeId).toBe('urn:orders')
  })
})
