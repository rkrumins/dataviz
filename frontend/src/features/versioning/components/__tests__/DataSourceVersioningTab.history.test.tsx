/**
 * DataSourceVersioningTab — its History is the whole graph's timeline: Published's revisions a page
 * at a time, its months, comparisons and what each revision changed. With the revision viewer it is
 * a way into the graph as it was: a revision opens (`/views/{view}?rev=K`), a comparison is
 * highlighted (`?rev=T&hl=K`) and Copy link copies the Open link, in one of the data source's views
 * — the one picked under "Open in", remembered per data source, and still picked for the page when
 * storage throws. With no views those three are disabled, saying why, and comparing still works;
 * without the preview, or without read access to the data source, the history lists with none of
 * its revision actions.
 * The data hooks are stubbed; the timeline, its rows, its months and the comparison are the real ones.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffSummaryResponse } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useNotificationStore } from '@/components/ui/notifications'

// jsdom has no layout: lay every item out, so the timeline's rows and its paging run.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 40, size: 40,
    })),
    getTotalSize: () => opts.count * 40,
    measureElement: () => undefined,
    scrollToIndex: vi.fn(),
  }),
}))

const COMMITS = [
  { commit_id: 'cmt_9', commit_seq: 9, message: 'Quarter close', actor: 'usr_abc123', created_at: '2026-10-31T17:42:00Z', stats: { update: 2 } },
  { commit_id: 'cmt_2', commit_seq: 2, message: 'Add Sales dataset', actor: 'usr_abc123', created_at: '2026-09-02T09:00:00Z', stats: { create: 1 } },
]

const SUMMARY: DiffSummaryResponse = {
  groups: [{
    key: 'DOM', kind: 'container', label: 'Sales', entityType: 'Dataset', status: 'unchanged',
    counts: { added: 1, modified: 0, removed: 0 }, childTotal: 1, deleted: false,
  }],
  groupTotal: 1,
  counts: { added: 1, modified: 0, removed: 0 },
  impact: { Dataset: 1, Table: 1 },
}

const state = vi.hoisted(() => ({
  revisionOn: true,
  canRead: true,
  hasNextPage: false,
  monthsLoaded: true,
  fetchNextPage: vi.fn(),
  historyPages: vi.fn(),
  historyMonths: vi.fn(),
  getRevision: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
  usePermission: (p: string) => (p === 'workspace:datasource:read' ? state.canRead : true),
}))
vi.mock('@/store/features', () => ({
  useFeature: (key: string) => (key === 'revisionViewerEnabled' ? state.revisionOn : true),
}))
vi.mock('@/hooks/useDataSourceProviderMap', () => ({ useDataSourceProviderMap: () => ({ resolve: () => undefined }) }))
vi.mock('../../hooks/useVersioning', () => ({
  VERSIONING_KEYS: { revision: (ws?: string, gid?: string | null, seq?: number | null) => ['versioning', 'revision', ws, gid, seq] },
  useResolveGraph: () => ({
    data: { graphId: 'g1', mainBranchId: 'b_main', mainHeadCommitSeq: 9, kind: 'bootstrap' },
    isLoading: false, isError: false, error: null, refetch: vi.fn(),
  }),
  useBranches: () => ({ data: [], isLoading: false }),
  useDataSourcePullRequests: () => ({ data: [], isLoading: false }),
  useForks: () => ({ data: [], refetch: vi.fn() }),
  useSetGraphFrozen: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useDataSourceDraftsPolicy: () => ({ data: undefined }),
  useSetDataSourceDraftsPolicy: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useHistoryPages: (...args: unknown[]) => {
    state.historyPages(...args)
    return {
      data: { pages: [{ commits: COMMITS, userNames: { usr_abc123: 'Ana Lee' }, hasMore: state.hasNextPage }] },
      isLoading: false, hasNextPage: state.hasNextPage, isFetchingNextPage: false, fetchNextPage: state.fetchNextPage,
    }
  },
  useHistoryMonths: (...args: unknown[]) => {
    state.historyMonths(...args)
    return {
      data: state.monthsLoaded ? { headSeq: 9, tz: 'UTC', months: [
        { month: '2026-09', count: 4, firstSeq: 2, lastSeq: 5, days: [] },
        { month: '2026-10', count: 12, firstSeq: 6, lastSeq: 9, days: [] },
      ] } : undefined,
      isLoading: false,
    }
  },
  useCommitDiffSummary: (_ws?: string, _gid?: string | null, cid?: string | null) => ({ data: cid ? SUMMARY : undefined, isLoading: false }),
  useSquashedCommits: () => ({ data: undefined, isLoading: false }),
  useRevision: () => ({ data: { openable: true, reason: null, changedSince: 40, limit: 100_000 }, isLoading: false }),
  useChangeSummary: () => ({ data: undefined, isLoading: false }),
  useRevertCommit: () => ({ mutate: vi.fn(), isPending: false }),
  useRestoreCommit: () => ({ mutate: vi.fn(), isPending: false }),
  useRestorePreview: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/versioningApiService')>(),
  getRevision: (...args: unknown[]) => state.getRevision(...args),
}))
vi.mock('../../model/useBootstrapWatch', () => ({
  useBootstrapWatch: () => ({ showReport: false, showProgress: false, job: null, dismissReport: () => {} }),
}))
vi.mock('../ForkStrip', () => ({ ForkStrip: () => null }))
vi.mock('../ForkDialog', () => ({ ForkDialog: () => null }))
vi.mock('../ProjectionHealthCard', () => ({ ProjectionHealthCard: () => null }))
vi.mock('../EnableVersioningFlow', () => ({ EnableVersioningFlow: () => null }))
vi.mock('../BootstrapProgress', () => ({ BootstrapProgress: () => null }))
vi.mock('../ChangeList', () => ({ ChangeList: () => null }))
// "To" picks the head itself, as a revision rather than as "Now".
vi.mock('../RevisionPicker', () => ({
  RevisionPicker: (p: { label: string; onChange: (seq: number | null) => void }) =>
    p.label === 'To' ? <button onClick={() => p.onChange(9)}>Pick #9</button> : null,
}))
vi.mock('@/features/reviews/components/PrDetailDrawer', () => ({ PrDetailDrawer: () => null }))

import { DataSourceVersioningTab } from '../DataSourceVersioningTab'

const NO_VIEWS = 'This data source has no views to open it in.'
const VIEWS = {
  ds1: [{ id: 'v1', name: 'Sales lineage' }, { id: 'v2', name: 'Finance map' }],
  ds2: [{ id: 'v3', name: 'Orders' }, { id: 'v4', name: 'Returns' }],
}

function Where() {
  const loc = useLocation()
  return <span data-testid="where">{loc.pathname}{loc.search}</span>
}

function renderTab(dataSourceId: 'ds1' | 'ds2' = 'ds1', views: Array<{ id: string; name: string }> = VIEWS[dataSourceId]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/workspaces/ws1?ds=${dataSourceId}&dstab=versioning`]}>
        <DataSourceVersioningTab wsId="ws1" dataSourceId={dataSourceId} views={views} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** The menu item of a revision's row, by its label. */
const menuItem = (label: string) => screen.getByText(label).closest('[role="menuitem"]') as HTMLElement
const where = () => screen.getByTestId('where').textContent

beforeEach(() => {
  state.revisionOn = true
  state.canRead = true
  state.hasNextPage = false
  state.monthsLoaded = true
  state.fetchNextPage.mockReset()
  state.historyPages.mockReset()
  state.historyMonths.mockReset()
  state.getRevision.mockReset().mockImplementation((_ws: string, _gid: string, seq: number) => Promise.resolve({
    openable: true, reason: null, commit: COMMITS.find((c) => c.commit_seq === seq), headSeq: 9, changedSince: 40, limit: 100_000,
  }))
  localStorage.clear()
  useBranchStore.getState().reset()
  useStagedChangesStore.setState({ changes: [] } as never)
  useNotificationStore.setState({ notifications: [] } as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DataSourceVersioningTab — history', () => {
  it('is the whole graph’s timeline, a page at a time, with its months', () => {
    state.hasNextPage = true
    renderTab()
    expect(screen.getByText('History (main)')).toBeInTheDocument()
    expect(screen.getByText('Quarter close')).toBeInTheDocument()
    expect(screen.getByText('Add Sales dataset')).toBeInTheDocument()
    expect(state.historyPages).toHaveBeenCalledWith('ws1', 'g1', { kind: 'graph' }, true, null)   // everyone's
    expect(state.historyMonths).toHaveBeenCalledWith('ws1', 'g1', null, true)
    expect(state.fetchNextPage).toHaveBeenCalled()
    expect(screen.queryByText('This view')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Go to a month')).toBeInTheDocument()
  })

  it('counts now from the data source’s own head until its months have loaded', async () => {
    state.monthsLoaded = false
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    expect(menuItem('Open on canvas')).not.toHaveAttribute('data-disabled')
  })

  it('opens a revision in the view picked', async () => {
    const user = userEvent.setup()
    renderTab()
    expect(screen.getByLabelText('Open in')).toHaveValue('v1')
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(screen.getByText('Open on canvas'))
    await waitFor(() => expect(where()).toBe('/views/v1?rev=2'))
    expect(state.getRevision).toHaveBeenCalledWith('ws1', 'g1', 2)
    // The canvas opens it from the link: nothing was opened here.
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('copies the link that opens it there, saying so', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    renderTab()
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(screen.getByText('Copy link'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/views/v1?rev=2`))
    expect(useNotificationStore.getState().notifications.at(-1)?.message).toMatch(/^Link copied/)
    expect(where()).toBe('/workspaces/ws1?ds=ds1&dstab=versioning')
  })

  it('highlights a comparison on the newer revision, in the view picked', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(screen.getByText('Compare with now'))
    await user.click(screen.getByText('Highlight on canvas'))
    expect(where()).toBe('/views/v1?rev=9&hl=2')
    expect(useBranchStore.getState().highlight).toBeNull()
  })

  it('opens a comparison’s end at the head as Published as it is, in the view picked', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(screen.getByText('Compare with now'))
    await user.click(screen.getByText('Pick #9'))
    await user.click(screen.getByText('Open #9'))
    expect(where()).toBe('/views/v1?rev=9')
    expect(state.getRevision).not.toHaveBeenCalled()
  })

  it('remembers the view picked, for each data source', async () => {
    const user = userEvent.setup()
    const first = renderTab('ds1')
    fireEvent.change(screen.getByLabelText('Open in'), { target: { value: 'v2' } })
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(screen.getByText('Open on canvas'))
    await waitFor(() => expect(where()).toBe('/views/v2?rev=2'))
    first.unmount()

    const other = renderTab('ds2')
    expect(screen.getByLabelText('Open in')).toHaveValue('v3')
    other.unmount()

    renderTab('ds1')
    expect(screen.getByLabelText('Open in')).toHaveValue('v2')
  })

  it('opens in the first view when the one remembered is gone', () => {
    localStorage.setItem('synodic.versioning.revisionsOpenIn.ds1', 'v_deleted')
    renderTab('ds1')
    expect(screen.getByLabelText('Open in')).toHaveValue('v1')
  })

  it('still picks a view for the page when storage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
    expect(() => localStorage.getItem('any')).toThrow()
    const user = userEvent.setup()
    renderTab('ds1')
    expect(screen.getByLabelText('Open in')).toHaveValue('v1')
    fireEvent.change(screen.getByLabelText('Open in'), { target: { value: 'v2' } })
    expect(screen.getByLabelText('Open in')).toHaveValue('v2')
    await user.click(screen.getAllByLabelText('Revision actions')[1])
    await user.click(screen.getByText('Open on canvas'))
    await waitFor(() => expect(where()).toBe('/views/v2?rev=2'))
  })

  it('with no views, disables Open, Highlight and Copy link, saying why; comparing still works', async () => {
    const user = userEvent.setup()
    renderTab('ds1', [])
    expect(screen.queryByLabelText('Open in')).not.toBeInTheDocument()

    await user.click(screen.getAllByLabelText('Revision actions')[1])
    expect(menuItem('Open on canvas')).toHaveAttribute('data-disabled')
    expect(within(menuItem('Open on canvas')).getByText(NO_VIEWS)).toBeInTheDocument()
    expect(menuItem('Copy link')).toHaveAttribute('data-disabled')
    expect(within(menuItem('Copy link')).getByText(NO_VIEWS)).toBeInTheDocument()
    expect(menuItem('Compare with now')).not.toHaveAttribute('data-disabled')

    await user.click(screen.getByText('Compare with now'))
    expect(screen.getByText('Compare revisions')).toBeInTheDocument()
    expect(screen.getByText('Highlight on canvas').closest('button')).toBeDisabled()
    expect(screen.getByText('Open #2').closest('button')).toBeDisabled()
    expect(screen.getByText(NO_VIEWS)).toBeInTheDocument()
    expect(where()).toBe('/workspaces/ws1?ds=ds1&dstab=versioning')
    expect(state.getRevision).not.toHaveBeenCalled()
  })

  it('with no views, still shows what a revision changed', () => {
    renderTab('ds1', [])
    fireEvent.click(screen.getByText('Add Sales dataset'))
    expect(screen.getByText('Sales')).toBeInTheDocument()
  })

  it.each([
    ['the preview is off', () => { state.revisionOn = false }],
    ['the person cannot read the data source', () => { state.canRead = false }],
  ])('lists the history without its revision actions when %s', (_why, given) => {
    given()
    renderTab()
    expect(screen.getByText('Add Sales dataset')).toBeInTheDocument()
    expect(screen.queryByLabelText('Revision actions')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Go to a month')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Open in')).not.toBeInTheDocument()
  })
})
