/**
 * ExportViewDialog — "View + data": a view on a version-controlled data source can be packaged with
 * its graph data (its own entities or the whole source, published or as in the person's draft);
 * anywhere else the option says why it isn't there.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewVersionPage } from '@/services/viewVersionsApiService'

const resolveGraphMock = vi.fn()

vi.mock('@/services/viewTransferApiService', () => ({ exportViews: vi.fn(), exportViewPackage: vi.fn() }))
vi.mock('@/services/viewVersionsApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/viewVersionsApiService')>(),
  listViewVersions: vi.fn(),
  getViewVersionStatus: vi.fn(),
}))
vi.mock('@/services/viewApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/viewApiService')>(),
  getView: vi.fn(async (id: string) => ({ id, name: 'Finance lineage', workspaceId: 'ws1', dataSourceId: 'ds1' })),
}))
vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/versioningApiService')>(),
  resolveGraph: (...args: unknown[]) => resolveGraphMock(...args),
}))
vi.mock('@/store/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/store/auth')>(),
  usePermission: () => true,
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

import { exportViewPackage } from '@/services/viewTransferApiService'
import { listViewVersions } from '@/services/viewVersionsApiService'
import { ExportViewDialog } from '../ExportViewDialog'

function page(): ViewVersionPage {
  return {
    items: [{
      version: 3, contentHash: 'sha256:3', name: 'Finance lineage', tags: [], source: 'wizard',
      stats: { layers: 3, assignments: 120 }, createdAt: new Date().toISOString(),
    }],
    hasMore: false, nextBefore: null, portableId: 'pv_1',
    workingCopy: { headVersion: 3, headHash: 'sha256:3', workingHash: 'sha256:3', designChanged: false, labelChanged: false, dirty: false },
  }
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ExportViewDialog views={[{ id: 'view_1', name: 'Finance lineage' }]} onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

describe('ExportViewDialog — a view with its data', () => {
  beforeEach(() => {
    vi.mocked(exportViewPackage).mockReset()
    vi.mocked(listViewVersions).mockResolvedValue(page())
    resolveGraphMock.mockReset()
  })

  it('packages the view with its data, from the draft when asked', async () => {
    resolveGraphMock.mockResolvedValue({ graphId: 'g1', mainBranchId: 'main', mainHeadCommitSeq: 9, myDraft: { branchId: 'br_1' } })
    vi.mocked(exportViewPackage).mockResolvedValue({
      jobId: 'exp_1', graphId: 'g1', workspaceId: 'ws1', fileName: 'finance-lineage.v3.view-package.zip',
      bundleHash: 'sha256:bundle0123456789abcdef', views: [{ viewId: 'view_1', version: 3 }],
      bytes: 4096, nodes: 120, edges: 80,
    })
    renderDialog()

    const withData = await screen.findByRole('radio', { name: /View \+ data/ })
    await waitFor(() => expect(withData).not.toBeDisabled())
    await userEvent.click(withData)
    expect(await screen.findByText('finance-lineage.v3.view-package.zip')).toBeInTheDocument()
    await userEvent.click(screen.getByText('The whole data source'))
    await userEvent.click(screen.getByText('In your draft'))
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))

    await waitFor(() => expect(exportViewPackage).toHaveBeenCalledTimes(1))
    expect(vi.mocked(exportViewPackage).mock.calls[0].slice(0, 2)).toEqual([
      [{ viewId: 'view_1', version: null }], { scope: 'source', dataVersion: 'draft', message: undefined },
    ])
    expect(await screen.findByText('Packaged')).toBeInTheDocument()
    expect(screen.getByText(/120 entities and 80 relationships/)).toBeInTheDocument()
  })

  it('says why the data can’t come along from a data source without version control', async () => {
    resolveGraphMock.mockRejectedValue(new Error('404 no versioned graph for data source'))
    renderDialog()
    expect(await screen.findByText(/Only a data source under version control can be packaged/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /View \+ data/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /View only/ })).toHaveAttribute('aria-checked', 'true')
  })
})
