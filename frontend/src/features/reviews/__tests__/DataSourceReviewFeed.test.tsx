/**
 * DataSourceReviewFeed — the review inbox's per-data-source read. It asks the data source for its
 * open PRs (status=open: every PR not yet merged or closed) as well as its latest page of PRs of
 * any status, so an older PR still awaiting review can't be pushed off that page by newer merged
 * or closed ones. The open read pages until it runs out, so no open PR falls off its end. A data
 * source with no versioned graph has no PRs; any other failed read keeps what the other one loaded
 * and is reported as failed.
 */
import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

const { listDataSourcePullRequests, resolveGraph, listMergeRequests } = vi.hoisted(() => ({
  listDataSourcePullRequests: vi.fn(),
  resolveGraph: vi.fn(),
  listMergeRequests: vi.fn(),
}))
vi.mock('@/services/versioningApiService', () => ({ listDataSourcePullRequests, resolveGraph, listMergeRequests }))

import { DataSourceReviewFeed, type ReviewItem } from '../components/DataSourceReviewFeed'
import type { PullRequest } from '@/services/versioningApiService'

function pr(prId: string, status: string, createdAt: string): PullRequest {
  return {
    prId, status, createdAt, updatedAt: createdAt, graphId: 'g1', sourceBranchId: `b_${prId}`,
    targetGraphId: 'g1', targetBranch: 'main',
  }
}

function renderFeed(onLoaded: (dsId: string, items: ReviewItem[]) => void) {
  // retry: 1 is the app's default (lib/queryClient).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataSourceReviewFeed wsId="ws1" dataSourceId="ds1" sourceLabel="Sales" onLoaded={onLoaded} />
    </QueryClientProvider>,
  )
}

describe('DataSourceReviewFeed', () => {
  it('keeps an older open PR that newer merged or closed PRs pushed off the latest page', async () => {
    const old = pr('pr_old', 'mergeable', '2026-01-01T00:00:00Z')
    const recent = [pr('pr_new', 'approved', '2026-10-02T00:00:00Z'), pr('pr_done', 'merged', '2026-10-01T00:00:00Z')]
    listDataSourcePullRequests.mockImplementation((_ws: string, _ds: string, params: { status?: string }) =>
      Promise.resolve(params.status === 'open' ? [recent[0], old] : recent))
    const onLoaded = vi.fn()
    renderFeed(onLoaded)

    await waitFor(() => expect(onLoaded).toHaveBeenCalled())
    const [dsId, items] = onLoaded.mock.calls.at(-1)!
    expect(dsId).toBe('ds1')
    expect((items as ReviewItem[]).map((i) => i.pr.prId).sort()).toEqual(['pr_done', 'pr_new', 'pr_old'])
    expect((items as ReviewItem[]).every((i) => i.sourceLabel === 'Sales')).toBe(true)
    expect(listDataSourcePullRequests).toHaveBeenCalledWith('ws1', 'ds1', { status: 'open', limit: 500, offset: 0 })
    // One read per data source: no graph lookup first.
    expect(resolveGraph).not.toHaveBeenCalled()
    expect(listMergeRequests).not.toHaveBeenCalled()
  })

  it('reports no PRs for a data source with no versioned graph, without retrying the 404', async () => {
    listDataSourcePullRequests.mockReset()
    listDataSourcePullRequests.mockRejectedValue(new Error('data source not found in workspace'))
    const onLoaded = vi.fn()
    renderFeed(onLoaded)

    await waitFor(() => expect(onLoaded).toHaveBeenCalledWith('ds1', [], false))
    expect(listDataSourcePullRequests).toHaveBeenCalledTimes(2) // open + latest, once each
  })

  it('keeps the open PRs it loaded and reports the failure when the latest-page read fails', async () => {
    const open = pr('pr_open', 'mergeable', '2026-01-01T00:00:00Z')
    listDataSourcePullRequests.mockReset()
    listDataSourcePullRequests.mockImplementation((_ws: string, _ds: string, params: { status?: string }) =>
      params.status === 'open' ? Promise.resolve([open]) : Promise.reject(new Error('500 Internal Server Error')))
    const onLoaded = vi.fn()
    renderFeed(onLoaded)

    await waitFor(() => expect(onLoaded).toHaveBeenCalled())
    expect(onLoaded).toHaveBeenLastCalledWith('ds1', [{ pr: open, sourceLabel: 'Sales' }], true)
  })

  it('keeps the latest page and reports the failure when the open read fails', async () => {
    const recent = pr('pr_new', 'approved', '2026-10-02T00:00:00Z')
    listDataSourcePullRequests.mockReset()
    listDataSourcePullRequests.mockImplementation((_ws: string, _ds: string, params: { status?: string }) =>
      params.status === 'open' ? Promise.reject(new Error('Request timed out')) : Promise.resolve([recent]))
    const onLoaded = vi.fn()
    renderFeed(onLoaded)

    await waitFor(() => expect(onLoaded).toHaveBeenCalled())
    expect(onLoaded).toHaveBeenLastCalledWith('ds1', [{ pr: recent, sourceLabel: 'Sales' }], true)
  })

  it('pages the open read until a short page, so open PRs past the first page are kept', async () => {
    const first = Array.from({ length: 500 }, (_, i) =>
      pr(`pr_${i}`, 'open', new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString()))
    const oldest = pr('pr_oldest', 'conflicts', '2025-01-01T00:00:00Z')
    listDataSourcePullRequests.mockReset()
    listDataSourcePullRequests.mockImplementation(
      (_ws: string, _ds: string, params: { status?: string; offset?: number }) =>
        Promise.resolve(params.status !== 'open' ? first.slice(0, 100) : params.offset ? [oldest] : first))
    const onLoaded = vi.fn()
    renderFeed(onLoaded)

    await waitFor(() => expect(onLoaded).toHaveBeenCalled())
    const items = onLoaded.mock.calls.at(-1)![1] as ReviewItem[]
    expect(items).toHaveLength(501)
    expect(items.some((i) => i.pr.prId === 'pr_oldest')).toBe(true)
    expect(listDataSourcePullRequests).toHaveBeenCalledWith('ws1', 'ds1', { status: 'open', limit: 500, offset: 500 })
  })
})
