/**
 * ChangeNavigator — a review one change at a time: it starts at the first change and says what it
 * is in plain words (a deletion with who and when, and where it lived; technical users also get the
 * type and qualified name), steps by button and by ← →, loading the next page when it gets there,
 * shows one operation at a time, opens the list (remembered) and the change's details, ends the
 * review, and gives way to a trace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChangeListPage, ChangeListRow, ChangeListSummary } from '@/services/versioningApiService'

const api = vi.hoisted(() => ({ getChangeSummary: vi.fn(), getChangeEntries: vi.fn(), getEntityDeletion: vi.fn() }))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useReviewStore } from '@/store/reviewStore'
import { ChangeNavigator } from '../ChangeNavigator'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { added: 1, modified: 0, removed: 2 },
  entityCounts: { added: 1, modified: 0, removed: 2 }, edgeCounts: NONE, structureCounts: NONE,
  impact: {}, byType: [{ kind: 'node', type: 'Column', added: 1, modified: 0, removed: 2 }],
  total: 3, listed: 3, approximate: false, tooLarge: null, window: null,
}
const col = (entityId: string, name: string, status: ChangeListRow['status'] = 'removed'): ChangeListRow => ({
  entityId, kind: 'node', status, type: 'Column', structural: false, displayName: name,
  qualifiedName: `wh.sales.orders.${name}`, urn: `urn:${name}`,
})
const page = (entries: ChangeListRow[], offset: number, total: number): ChangeListPage =>
  ({ entries, total, offset, limit: 100, hasMore: offset + entries.length < total })
const s = () => useReviewStore.getState()

function renderNavigator(hidden = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><ChangeNavigator viewId="v1" hidden={hidden} /></QueryClientProvider>)
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.getChangeSummary.mockResolvedValue(summary)
  api.getChangeEntries
    .mockResolvedValueOnce(page([col('c1', 'amount'), col('c2', 'currency')], 0, 3))
    .mockResolvedValueOnce(page([col('c3', 'order_id', 'added')], 2, 3))
  api.getEntityDeletion.mockResolvedValue({
    entityId: 'c1', kind: 'node', urn: 'urn:amount', userNames: { 'u-ana': 'Ana' },
    ancestors: [{ urn: 'urn:sales', displayName: 'Sales' }, { urn: 'urn:crm', displayName: 'crm' }],
    deleted: { seq: 9, commitId: 'c9', message: null, at: new Date(Date.now() - 3 * 86_400_000).toISOString(), deletedBy: 'u-ana', inDraft: true },
  })
  usePersonaStore.setState({ mode: 'business' })
  useBranchStore.getState().reset()
  useBranchStore.setState({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1', graphId: 'g1', currentBranchId: 'br_1' })
  useCanvasStore.getState().setNodesAndEdges([], [])
  useCanvasStore.setState({ drawerNodeId: null })
  useReviewStore.setState({ available: true, navigatorOpen: true, listOpen: false, listPreferred: null,
    scope: null, operation: null, filter: {}, current: null, position: 0, found: null })
})

describe('ChangeNavigator', () => {
  it('starts at the first change, and says what it is in plain words', async () => {
    renderNavigator()
    expect(await screen.findByText('amount')).toBeInTheDocument()
    expect(s()).toMatchObject({ current: { entityId: 'c1' }, position: 0 })
    expect(await screen.findByText('from Sales › crm')).toBeInTheDocument()
    // When, as the app says it everywhere: within the week, the day and time.
    expect(screen.getByText(/by Ana/)).toHaveTextContent(/^by Ana · \w{3} \d{1,2}:\d{2}/)
    expect(api.getEntityDeletion).toHaveBeenCalledWith('ws1', 'g1', 'c1', { branchId: 'br_1', atSeq: null, kind: 'node' })
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.queryByText('wh.sales.orders.amount')).toBeNull()        // not for business users
  })

  it('gives technical users the type and the qualified name', async () => {
    usePersonaStore.setState({ mode: 'technical' })
    renderNavigator()
    expect(await screen.findByText('wh.sales.orders.amount')).toBeInTheDocument()
    expect(screen.getByText('Column')).toBeInTheDocument()
  })

  it('steps by button and by arrow key, loading the next page when it gets there', async () => {
    renderNavigator()
    await screen.findByText('amount')
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }))
    expect(s()).toMatchObject({ current: { entityId: 'c2' }, position: 1 })

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(s()).toMatchObject({ current: { entityId: 'c3' }, position: 2 }))
    expect(api.getChangeEntries).toHaveBeenLastCalledWith('ws1', 'g1', { branchId: 'br_1' },
      expect.objectContaining({ kind: 'node' }), 2, 100)
    expect(screen.getByRole('button', { name: 'Next change' })).toBeDisabled()     // the last of them

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(s().position).toBe(1)
  })

  it('shows one operation at a time, from its first change', async () => {
    api.getChangeEntries.mockReset()
    api.getChangeEntries.mockResolvedValue(page([col('c3', 'order_id', 'added')], 0, 1))
    renderNavigator()
    await screen.findByText('order_id')
    fireEvent.click(screen.getByRole('radio', { name: /^Added/ }))
    await waitFor(() => expect(api.getChangeEntries).toHaveBeenLastCalledWith('ws1', 'g1', { branchId: 'br_1' },
      expect.objectContaining({ statuses: ['added'] }), 0, 100))
    await waitFor(() => expect(s()).toMatchObject({ operation: 'added', current: { entityId: 'c3' }, position: 0 }))
  })

  it('opens the list, remembering it, opens the details of a change on the canvas, and ends', async () => {
    useCanvasStore.getState().addNodes([{ id: 'urn:amount', type: 'generic', position: { x: 0, y: 0 }, data: { urn: 'urn:amount' } } as never])
    renderNavigator()
    await screen.findByText('amount')

    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(s()).toMatchObject({ listOpen: true, listPreferred: true })
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(useCanvasStore.getState().drawerNodeId).toBe('urn:amount')
    fireEvent.click(screen.getByRole('button', { name: 'End the review' }))
    expect(s()).toMatchObject({ navigatorOpen: false, listOpen: false })
  })

  it('says when the change is not on this canvas', async () => {
    renderNavigator()
    await screen.findByText('amount')
    useReviewStore.setState({ found: 'missing' })
    expect(await screen.findByText(/isn't on this canvas/)).toBeInTheDocument()
  })

  it('gives way to a trace', () => {
    const { container } = renderNavigator(true)
    expect(container).toBeEmptyDOMElement()
    expect(api.getChangeSummary).not.toHaveBeenCalled()
  })
})
