/**
 * TombstoneDetails — a deleted entity's details: who deleted it, when and in which revision, who
 * published it and why, where it lived and what it held; what went with it and its history only once
 * unfolded. On a canvas of its graph it opens the graph just before the deletion, on the entity (held
 * back while edits are unsaved; too far back, the comparison with now), and shows the change. A row
 * of a change list opens it in a drawer, and nothing is asked until then.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getEntityDeletion: vi.fn(),
  getDeletionCascade: vi.fn(),
  getRevision: vi.fn(),
  getEntityHistoryPage: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))

import { queryClient } from '@/lib/queryClient'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { useAuthStore } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { buildChangeSet, type GraphChange } from '../../model/changeModel'
import { ChangesPanel } from '../ChangesPanel'
import { EntityHistory } from '../EntityHistory'
import { TombstoneDetails, type TombstoneTarget } from '../TombstoneDetails'

const schema: ResolvedViewSchema = {
  entityTypes: [], relationshipTypes: [], containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: [], rootEntityTypes: [],
}
const published: TombstoneTarget = {
  wsId: 'ws', graphId: 'g', entityId: 'e-orders', kind: 'node', origin: { fromSeq: 41, toSeq: 42 }, label: 'orders',
}
const deletion = (deleted: Record<string, unknown> = {}) => ({
  entityId: 'e-orders', kind: 'node', urn: 'urn:orders',
  deleted: {
    seq: 42, commitId: 'c42', commitKind: 'squash', message: 'Drop the old orders table', at: '2026-11-06T10:00:00Z',
    deletedBy: 'u-ana', mergedBy: 'u-ben', mergedAt: '2026-11-07T10:00:00Z', inDraft: false, ...deleted,
  },
  lastValue: { displayName: 'orders', entityType: 'Table', properties: { owner: 'sales-team' } },
  ancestors: [{ urn: 'urn:wh', displayName: 'Warehouse' }, { urn: 'urn:sales', displayName: 'Sales' }],
  userNames: { 'u-ana': 'Ana', 'u-ben': 'Ben' },
})
const node = (urn: string, name: string) => ({
  entityId: urn, kind: 'node', status: 'removed', urn, before: { displayName: name, entityType: 'Column' }, after: null,
})

let client: QueryClient
const show = (ui: ReactNode, { onCanvas = false } = {}) => render(
  <QueryClientProvider client={client}>
    {onCanvas ? <StaticViewSchemaProvider schema={schema}>{ui}</StaticViewSchemaProvider> : ui}
  </QueryClientProvider>,
)

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.clear()
  Object.values(api).forEach((f) => f.mockReset())
  api.getEntityDeletion.mockResolvedValue(deletion())
  api.getEntityHistoryPage.mockResolvedValue({ entityId: 'e-orders', versions: [], userNames: {}, hasMore: false })
  useAuthStore.setState({ permissions: { sid: 't', global: ['system:admin'], ws: {} }, permissionsStatus: 'ready' } as never)
  useBranchStore.setState({ graphId: 'g', revision: null } as never)
  useStagedChangesStore.setState({ changes: [] })
  useVersioningPanelStore.setState({ requestedTab: null, requestedCompare: null })
})

describe('TombstoneDetails', () => {
  it('says who deleted it, in which revision, who published it and why; where it lived and what it held', async () => {
    show(<TombstoneDetails target={published} />)
    expect(await screen.findByText('Deleted in #42')).toBeInTheDocument()
    expect(api.getEntityDeletion).toHaveBeenCalledWith('ws', 'g', 'e-orders', { branchId: null, atSeq: 42, kind: 'node' })
    const banner = screen.getByRole('region', { name: 'How it was deleted' })
    expect(banner).toHaveTextContent('by Ana')
    expect(banner).toHaveTextContent('published by Ben')
    expect(banner).toHaveTextContent('“Drop the old orders table”')
    const where = screen.getByRole('list', { name: 'Where it lived' })
    expect(within(where).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Warehouse', 'Sales', 'orders'])
    expect(screen.getByText(/sales-team/)).toBeInTheDocument()
    // What went with it and its history are asked for only once unfolded.
    expect(api.getDeletionCascade).not.toHaveBeenCalled()
    expect(api.getEntityHistoryPage).not.toHaveBeenCalled()
  })

  it('unfolds what went with it, named, and only then asks for it', async () => {
    api.getDeletionCascade.mockResolvedValue({
      origin: { fromSeq: 41, toSeq: 42 }, root: 'e-orders', total: { nodes: 3, links: 1 }, restorable: true,
      removed: [
        node('urn:orders', 'orders'), node('urn:orders.id', 'order_id'), node('urn:orders.amount', 'amount'),
        { entityId: 'f1', kind: 'edge', status: 'removed', before: { edgeType: 'FLOWS_TO' }, after: null,
          sourceUrn: 'urn:orders.amount', targetUrn: 'urn:revenue' },
      ],
    })
    show(<TombstoneDetails target={published} />)
    fireEvent.click(await screen.findByRole('button', { name: 'What went with it' }))
    expect(await screen.findByText(/Also removed/)).toBeInTheDocument()
    expect(api.getDeletionCascade).toHaveBeenCalledWith('ws', 'g', 'e-orders', { fromSeq: 41, toSeq: 42 })
    expect(screen.getByText('order_id')).toBeInTheDocument()
    expect(screen.getAllByText('amount').length).toBeGreaterThan(0)
  })

  it('says when too much went with it to list', async () => {
    api.getDeletionCascade.mockResolvedValue({
      origin: { fromSeq: 41, toSeq: 42 }, root: 'e-orders', total: { nodes: 1201, links: 30 }, restorable: false,
      reason: 'too_large', removed: [],
    })
    show(<TombstoneDetails target={published} />)
    fireEvent.click(await screen.findByRole('button', { name: 'What went with it' }))
    expect(await screen.findByText('Too much went with it to list here: 1,200 entities and 30 relationships.')).toBeInTheDocument()
  })

  it('unfolds its history, without offering its own details again', async () => {
    api.getEntityHistoryPage.mockResolvedValue({
      entityId: 'e-orders', userNames: { 'u-ben': 'Ben' }, hasMore: false,
      versions: [{ id: 'v2', commit_id: 'c42', commit_seq: 42, branch_id: 'main', op: 'delete', content_hash: 'x',
        actor: 'u-ben', created_at: '2026-11-07T10:00:00Z', changes: [], on_draft: false, after_branch_point: false }],
    })
    show(<TombstoneDetails target={published} />)
    fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    expect(await screen.findByText('deleted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Deletion details/ })).toBeNull()
  })

  it('on a canvas, opens the graph just before it was deleted, on the entity', async () => {
    api.getRevision.mockResolvedValue({
      openable: true, headSeq: 50, changedSince: 9, limit: 100000, reason: null, userNames: {},
      commit: { commit_id: 'c41', created_at: '2026-11-05T10:00:00Z', message: 'Nightly', actor: 'u-ben' },
    })
    const onNavigate = vi.fn()
    show(<TombstoneDetails target={published} onNavigate={onNavigate} />, { onCanvas: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Open just before it was deleted' }))
    await waitFor(() => expect(useBranchStore.getState().revision).toMatchObject({ seq: 41, headAtOpen: 50, reveal: 'urn:orders' }))
    expect(api.getRevision).toHaveBeenCalledWith('ws', 'g', 41)
    expect(onNavigate).toHaveBeenCalled()
  })

  it('too far back to draw, shows the comparison with now instead', async () => {
    api.getRevision.mockResolvedValue({ openable: false, reason: 'too_far', headSeq: 50, commit: {}, userNames: {} })
    show(<TombstoneDetails target={published} />, { onCanvas: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Open just before it was deleted' }))
    await waitFor(() => expect(useVersioningPanelStore.getState().requestedCompare).toEqual({ fromSeq: 41, toSeq: null }))
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('holds the graph back while edits are unsaved', async () => {
    useStagedChangesStore.setState({ changes: [{ id: 's', type: 'update_entity', targetId: 'x', summary: '', timestamp: 0 } as never] })
    show(<TombstoneDetails target={published} />, { onCanvas: true })
    expect(await screen.findByRole('button', { name: 'Open just before it was deleted' })).toBeDisabled()
  })

  it('shows the change: the revision that deleted it', async () => {
    show(<TombstoneDetails target={published} />, { onCanvas: true })
    fireEvent.click(await screen.findByRole('button', { name: 'See the change' }))
    expect(useVersioningPanelStore.getState().requestedCompare).toEqual({ fromSeq: 41, toSeq: 42 })
  })

  it('a deletion in a draft says so, and its change is the draft’s', async () => {
    api.getEntityDeletion.mockResolvedValue(deletion({ seq: 7, inDraft: true, mergedBy: null, mergedAt: null }))
    show(<TombstoneDetails target={{ ...published, origin: { branchId: 'd1' } }} />, { onCanvas: true })
    expect(await screen.findByText('Deleted in this draft')).toBeInTheDocument()
    expect(api.getEntityDeletion).toHaveBeenCalledWith('ws', 'g', 'e-orders', { branchId: 'd1', atSeq: null, kind: 'node' })
    expect(screen.queryByRole('button', { name: 'Open just before it was deleted' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'See the change' }))
    expect(useVersioningPanelStore.getState().requestedTab).toBe('changes')
  })

  it('offers nothing that moves a canvas where there is none', async () => {
    show(<TombstoneDetails target={published} />)
    expect(await screen.findByText('Deleted in #42')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open just before it was deleted' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'See the change' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy URN' })).toBeInTheDocument()
  })
})

describe('a deleted row of a change list', () => {
  const origin = { source: 'branch', branchId: 'd1' } as const
  const many: GraphChange[] = Array.from({ length: 100 }, (_, i) => ({
    entityId: `e${i}`, urn: `urn:${i}`, kind: 'node', status: 'removed', label: `table_${i}`, origin, before: { displayName: `table_${i}` },
  }))

  it('asks nothing until its details are opened, then opens them above the panel', async () => {
    show(<ChangesPanel changeSet={buildChangeSet(many)} details={{ wsId: 'ws', graphId: 'g' }} />)
    fireEvent.click(screen.getByText('table_7'))
    fireEvent.click(screen.getByRole('button', { name: /Deletion details/ }))
    const dialog = await screen.findByRole('dialog', { name: 'table_7' })
    expect(await within(dialog).findByText('Deleted in #42')).toBeInTheDocument()
    expect(api.getEntityDeletion).toHaveBeenCalledTimes(1)
    expect(api.getEntityDeletion).toHaveBeenCalledWith('ws', 'g', 'e7', { branchId: 'd1', atSeq: null, kind: 'node' })
    act(() => { fireEvent.keyDown(window, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers none where the panel isn’t told its graph (staged edits)', () => {
    show(<ChangesPanel changeSet={buildChangeSet(many.slice(0, 1))} />)
    fireEvent.click(screen.getByText('table_0'))
    expect(screen.queryByRole('button', { name: /Deletion details/ })).toBeNull()
  })
})

describe('EntityHistory', () => {
  it('links a published revision to what it changed, and a deletion to its details', async () => {
    api.getEntityHistoryPage.mockResolvedValue({
      entityId: 'e-orders', userNames: {}, hasMore: false,
      versions: [{ id: 'v2', commit_id: 'c42', commit_seq: 42, branch_id: 'main', op: 'delete', content_hash: 'x',
        actor: 'u-ben', created_at: '2026-11-07T10:00:00Z', changes: [], on_draft: false, after_branch_point: false }],
    })
    show(<EntityHistory wsId="ws" graphId="g" entityId="e-orders" />, { onCanvas: true })
    fireEvent.click(await screen.findByRole('button', { name: '#42' }))
    expect(useVersioningPanelStore.getState().requestedCompare).toEqual({ fromSeq: 41, toSeq: 42 })
    fireEvent.click(screen.getByRole('button', { name: /Deletion details/ }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(api.getEntityDeletion).toHaveBeenCalledWith('ws', 'g', 'e-orders', { branchId: null, atSeq: 42, kind: 'node' })
  })
})
