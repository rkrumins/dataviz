/**
 * PublishForm — a publish refused because values break the fields their entity types define says
 * so, entity by entity: its name, its type, what is wrong — and the way to it: an entity on the
 * canvas opens in the drawer, one that isn't offers its id to find it by. Past the values it lists,
 * it counts them all, field by field. Nothing was published. A required field left empty is filled on
 * the entities refused (by id) from the bulk dialog — on the draft open on the canvas.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { FieldViolationError, type FieldViolation, type FieldViolationCount } from '@/services/versioningApiService'

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
const branch = vi.hoisted(() => ({ currentBranchId: null as string | null }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToMain: vi.fn(), currentBranchId: branch.currentBranchId }),
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
  branch.currentBranchId = null
  usePropertyJobsStore.setState({ request: null } as never)
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

describe('PublishForm — filling a required field the publish refused', () => {
  const refuse = (byField: FieldViolationCount[], total = 2) =>
    publishMutate.mockImplementation((_vars, { onError }) => onError(new FieldViolationError(violations, total, byField)))
  const publish = async (onClose = vi.fn()) => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <CommitDialog workspaceId="ws1" graphId="g1" branchId="br_1" changeSet={changeSet} onClose={onClose} />
      </MemoryRouter>,
    )
    await user.click(screen.getByRole('button', { name: /publish now/i }))
    return { user, onClose }
  }
  const owner: FieldViolationCount = {
    entityType: 'Table', field: 'owner', fieldName: 'Owner', rule: 'field_required', count: 2, ids: ['gv:e9', 'gv:e7'], idsComplete: true,
  }
  const tier: FieldViolationCount = {
    entityType: 'Table', field: 'tier', fieldName: 'Tier', rule: 'field_not_allowed', count: 1, ids: ['gv:e1'], idsComplete: true,
  }

  it('fills every entity refused for it from the bulk dialog — a required field only — closing the publish', async () => {
    branch.currentBranchId = 'br_1'
    refuse([owner, tier])
    const { user, onClose } = await publish()
    const [ownerRow, tierRow] = within(screen.getByRole('list', { name: 'Values to change by field' })).getAllByRole('listitem')
    expect(within(tierRow).queryByRole('button')).toBeNull()
    await user.click(within(ownerRow).getByRole('button', { name: 'Fill 2 missing…' }))
    expect(onClose).toHaveBeenCalled()
    expect(usePropertyJobsStore.getState().request).toEqual({
      op: { kind: 'fillEmpty', key: 'owner' },
      target: { kind: 'selection', ids: ['gv:e9', 'gv:e7'], entityTypes: ['Table'], label: 'every Table the publish refused for missing Owner' },
    })
  })

  it('past what one change takes, fills the first and says the next publish finds the rest', async () => {
    branch.currentBranchId = 'br_1'
    refuse([{ ...owner, count: 25_000, ids: ['gv:e9'], idsComplete: false }], 25_000)
    const { user } = await publish()
    const row = within(screen.getByRole('list', { name: 'Values to change by field' })).getByRole('listitem')
    expect(row).toHaveTextContent('Table · Owner: 25,000 missingFill the first 1… then publish again for the rest')
    await user.click(within(row).getByRole('button', { name: 'Fill the first 1…' }))
    expect(usePropertyJobsStore.getState().request?.target).toMatchObject({ ids: ['gv:e9'], label: 'the first 1 the publish refused for missing Owner on Table' })
  })

  it('is not offered for a draft the canvas isn’t on — the bulk dialog writes to that one', async () => {
    branch.currentBranchId = 'br_other'
    refuse([owner])
    await publish()
    expect(screen.queryByRole('button', { name: /^Fill/ })).toBeNull()
  })
})
