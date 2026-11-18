/**
 * Review & Save is one guided flow: it says what each change does in words (never the node as
 * JSON), saves to the draft as often as you like, and — when you choose — goes on from the save to
 * publishing, in the same dialog, over the whole draft. With nothing staged but a draft that has
 * changes, it opens on Publish.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom has no layout: lay every row of the virtualized list out.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 52, size: 52,
    })),
    getTotalSize: () => opts.count * 52,
    scrollToIndex: () => undefined,
  }),
}))

const publishMutate = vi.fn()
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useChangeSummary: () => ({ data: { counts: { added: 1, modified: 2, removed: 0 } }, isLoading: false, isFetching: false }),
  useDataSourceDraftsPolicy: () => ({ data: undefined }),
  usePublishBranch: () => ({ mutate: publishMutate, isPending: false }),
  useOpenMergeRequest: () => ({ mutate: vi.fn(), isPending: false }),
  useLivePrForBranch: () => ({ livePr: undefined, pending: false }),
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/features/versioning/hooks/useActiveDraftAccess', () => ({
  useActiveDraftAccess: () => ({ draft: null, canWrite: true, canManage: true }),
}))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('@/features/versioning/components/ChangeList', () => ({
  ChangeList: ({ origin }: { origin: { branchId: string } }) => <div>saved list of {origin.branchId}</div>,
}))

import { StagedChangesPanel } from '../StagedChangesPanel'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { buildChangeSet } from '@/features/versioning/model/changeModel'

const edit: StagedChange = {
  id: 'c1', type: 'update_entity', targetId: 'urn:orders', targetUrn: 'urn:orders', timestamp: 1,
  summary: "Edit 1 field on 'Orders'",
  before: { label: 'Orders', urn: 'urn:orders', properties: { owner: 'ana', labels: ['pii'] } },
  after: { label: 'Orders', urn: 'urn:orders', properties: { owner: 'bea', labels: ['pii', 'gdpr'] } },
}

const state = () => useStagedChangesStore.getState()

function renderPanel(onConfirm: () => Promise<boolean> | boolean = async () => true) {
  return render(
    <MemoryRouter>
      <StagedChangesPanel onConfirm={onConfirm} wsId="ws1" graphId="g1" dataSourceId="ds1" viewId="v1" />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  publishMutate.mockReset()
  useStagedChangesStore.setState({
    changes: [edit], past: [], redoStack: [], isReviewPanelOpen: false, reviewIntent: null, applyStatus: 'idle', lastApplyResult: null,
  } as never)
  useBranchStore.setState({ currentBranchId: 'br1', activeChangeSet: null } as never)
  useCanvasStore.setState({ nodes: [{ id: 'urn:orders', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'Orders', urn: 'urn:orders', type: 'dataset' } }] } as never)
})

describe('Review & Save — the guided flow', () => {
  it('says what a change does, with the values it changes — not JSON', async () => {
    renderPanel()
    act(() => state().openReviewPanel())
    const dialog = screen.getByRole('dialog', { name: 'Review & Save Changes' })
    // A summary first — what it edits — then (one change: opened at once) the values themselves.
    expect(within(dialog).getAllByText(/^Edited (labels and owner|owner and labels)$/).length).toBeGreaterThan(0)
    expect(within(dialog).getByText('owner')).toBeInTheDocument()
    expect(within(dialog).getByText('bea')).toBeInTheDocument()
    expect(within(dialog).getByText('+ gdpr')).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('"properties"')
  })

  it('Save to draft closes once the changes are written', async () => {
    const onConfirm = vi.fn(async () => true)
    renderPanel(onConfirm)
    act(() => state().openReviewPanel())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save 1 change/ })) })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(state().isReviewPanelOpen).toBe(false)
  })

  it('stays on the review when the save is refused', async () => {
    renderPanel(async () => false)
    act(() => state().openReviewPanel())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save 1 change/ })) })
    expect(state().isReviewPanelOpen).toBe(true)
    expect(screen.getByRole('button', { name: /Save 1 change/ })).toBeInTheDocument()
  })

  it('Save & publish saves, then goes on to Publish with a title from what was saved', async () => {
    const onConfirm = vi.fn(async () => true)
    renderPanel(onConfirm)
    act(() => state().openReviewPanel())
    fireEvent.click(screen.getByRole('radio', { name: /Save & publish/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Save & continue to publish/ })) })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(state().isReviewPanelOpen).toBe(true)
    expect(screen.getByPlaceholderText('A short summary of these changes…')).toHaveValue('Update Orders')

    act(() => { useStagedChangesStore.setState({ changes: [] }) })   // the save cleared what it carried
    fireEvent.click(screen.getByRole('button', { name: /Publish now/ }))
    expect(publishMutate).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'br1', message: 'Update Orders' }), expect.anything())
  })

  it('opened for publishing, it starts with Save & publish chosen', () => {
    renderPanel()
    act(() => state().openReviewPanel('publish'))
    expect(screen.getByRole('radio', { name: /Save & publish/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('with nothing staged but changes on the draft, it opens on Publish', () => {
    useStagedChangesStore.setState({ changes: [] })
    useBranchStore.setState({
      activeChangeSet: buildChangeSet([{ entityId: 'e1', kind: 'node', status: 'added', label: 'New', origin: { source: 'branch', branchId: 'br1' } }]),
    } as never)
    renderPanel()
    act(() => state().openReviewPanel())
    expect(screen.getByRole('button', { name: /Publish now/ })).toBeInTheDocument()
    expect(screen.getByText(/Nothing new to save/)).toBeInTheDocument()
  })

  it('a click on the Review & Save button (its event) never opens it for publishing', () => {
    renderPanel()
    act(() => state().openReviewPanel({ type: 'click' }))
    expect(state().reviewIntent).toBeNull()
    expect(screen.getByRole('radio', { name: /Save to draft/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('opened after an import, it lists what the draft holds, a page at a time — not Publish', async () => {
    useStagedChangesStore.setState({ changes: [] })
    useBranchStore.setState({
      activeChangeSet: buildChangeSet([{ entityId: 'urn:orders', urn: 'urn:orders', kind: 'node', status: 'added', label: 'urn:orders', origin: { source: 'branch', branchId: 'br1' } }]),
    } as never)
    renderPanel()
    act(() => state().openReviewPanel('saved'))
    expect(screen.queryByRole('button', { name: /Publish now/ })).not.toBeInTheDocument()
    expect(screen.getByText('saved list of br1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Already saved on this draft/ })).toHaveAttribute('aria-expanded', 'true')
  })
})
