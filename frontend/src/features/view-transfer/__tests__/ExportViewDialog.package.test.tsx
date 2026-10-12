/**
 * ExportViewDialog — "View + data": a view on a version-controlled data source can be packaged with
 * its graph data (its own entities or the whole source, published or as in the person's draft);
 * anywhere else the option says why it isn't there. The server builds the package: the dialog
 * says how far it has got and that the download starts by itself, can be closed meanwhile (the
 * package carries on, and the export tray shows it), and opened again on the same views shows it
 * once more; it can be cancelled, asked once more first; a request whose answer was lost is retried
 * under the same request id.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'
import type { PackageStarted } from '@/services/viewTransferApiService'
import type { ViewVersionPage } from '@/services/viewVersionsApiService'

const resolveGraphMock = vi.fn()

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  getExport: vi.fn(),
  cancelExport: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))
vi.mock('@/services/viewTransferApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/viewTransferApiService')>(),
  exportViews: vi.fn(),
  startViewPackage: vi.fn(),
  previewExport: vi.fn(async (ids: string[]) => ({
    views: ids.map((viewId) => ({
      viewId, name: 'Finance lineage', workspaceId: 'ws1', dataSourceId: 'ds1', headVersion: 3, dirty: false,
      maySeal: true, exportsAs: 3, includesUnsaved: false, stats: { layers: 3, assignments: 120 }, estimatedBytes: 1000,
    })),
  })),
}))
vi.mock('@/services/viewVersionsApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/viewVersionsApiService')>(),
  listViewVersions: vi.fn(),
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

import { cancelExport, getExport, triggerBrowserDownload } from '@/services/importExportApiService'
import { startViewPackage } from '@/services/viewTransferApiService'
import { listViewVersions } from '@/services/viewVersionsApiService'
import { dismissExport, trackExport, useBackgroundExports } from '@/features/import-export/backgroundExports'
import { ExportViewDialog } from '../ExportViewDialog'

const STARTED: PackageStarted = {
  jobId: 'exp_1', graphId: 'g1', workspaceId: 'ws1', fileName: 'finance-lineage.v3.view-package.zip', status: 'pending',
  views: [{ viewId: 'view_1', version: 3 }], requestId: 'req-1',
}

/** The package's job, as the server answers about it while it builds the package. */
function building(job: Partial<Job>) {
  vi.mocked(getExport).mockResolvedValue({ jobId: 'exp_1', jobType: 'export', graphId: 'g1', status: 'running', ...job })
}

const tracked = () => useBackgroundExports.getState().exports.find((e) => e.jobId === 'exp_1')

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

function renderDialog(props: Partial<React.ComponentProps<typeof ExportViewDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const view = render(
    <QueryClientProvider client={client}>
      <ExportViewDialog views={[{ id: 'view_1', name: 'Finance lineage' }]} onClose={onClose} {...props} />
    </QueryClientProvider>,
  )
  return { onClose, unmount: view.unmount }
}

async function chooseData() {
  const withData = await screen.findByRole('radio', { name: /View \+ data/ })
  await waitFor(() => expect(withData).not.toBeDisabled())
  await userEvent.click(withData)
}

describe('ExportViewDialog — a view with its data', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(startViewPackage).mockReset().mockResolvedValue(STARTED)
    vi.mocked(getExport).mockReset()
    vi.mocked(cancelExport).mockReset()
    vi.mocked(triggerBrowserDownload).mockReset()
    vi.mocked(listViewVersions).mockResolvedValue(page())
    resolveGraphMock.mockReset()
    resolveGraphMock.mockResolvedValue({ graphId: 'g1', mainBranchId: 'main', mainHeadCommitSeq: 9, myDraft: { branchId: 'br_1' } })
  })

  afterEach(() => {
    for (const e of useBackgroundExports.getState().exports) dismissExport(e.jobId)
    useBackgroundExports.setState({ exports: [], shown: [] })
  })

  it('packages the view with its data, from the draft when asked', async () => {
    vi.mocked(getExport).mockResolvedValue({
      jobId: 'exp_1', jobType: 'export', graphId: 'g1', status: 'completed', kept: true,
      summary: { nodes: 120, edges: 80, bytes: 4096, package: { bytes: 4096, bundleHash: 'sha256:bundle0123456789abcdef' } } as Job['summary'],
    })
    renderDialog()

    await chooseData()
    expect(await screen.findByText('finance-lineage.v3.view-package.zip')).toBeInTheDocument()
    await userEvent.click(screen.getByText('The whole data source'))
    await userEvent.click(screen.getByText('In your draft'))
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))

    await waitFor(() => expect(startViewPackage).toHaveBeenCalledTimes(1))
    expect(vi.mocked(startViewPackage).mock.calls[0]).toEqual([
      [{ viewId: 'view_1', version: null }],
      { scope: 'source', dataVersion: 'draft', message: undefined, requestId: expect.any(String) },
    ])
    expect(getExport).toHaveBeenCalledWith('ws1', 'g1', 'exp_1')
    expect(await screen.findByText('Packaged')).toBeInTheDocument()
    expect(screen.getByText(/120 entities and 80 relationships/)).toBeInTheDocument()
    expect(triggerBrowserDownload).toHaveBeenCalledWith(
      '/api/v1/ws1/versioning/graphs/g1/exports/exp_1/download', 'finance-lineage.v3.view-package.zip')
  })

  it('says how far the package has got, and can be closed while the server builds it', async () => {
    building({ phase: 'data', summary: { nodes: 1200, edges: 800, bytes: 4096 }, attempt: 2 })
    const { onClose, unmount } = renderDialog()
    await chooseData()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))

    expect(await screen.findByText('Writing the data… 1,200 entities and 800 relationships so far')).toBeInTheDocument()
    expect(screen.getByText('Resumed where it left off (attempt 2).')).toBeInTheDocument()
    expect(screen.getByText('Step 3 of 4 · Writing the data')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Export steps' })).getByText('Writing the data').closest('li'))
      .toHaveAttribute('aria-current', 'step')
    expect(screen.getByText(/Your download starts automatically/)).toBeInTheDocument()
    const footerClose = screen.getAllByRole('button', { name: 'Close' }).at(-1)!
    expect(footerClose).toBeEnabled()
    await userEvent.click(footerClose)
    expect(onClose).toHaveBeenCalled()

    unmount()
    expect(tracked()?.viewIds).toEqual(['view_1'])         // it carries on, and the export tray shows it
    expect(useBackgroundExports.getState().shown).toEqual([])
  })

  it('opens on a package the server was building when it last closed', async () => {
    building({ phase: 'bundle' })
    trackExport({ jobId: 'exp_1', kind: 'package', wsId: 'ws1', graphId: 'g1', fileName: STARTED.fileName,
      label: 'Finance lineage · view + data', viewIds: ['view_1'] })
    renderDialog()

    expect(await screen.findByText('Packing the views…')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Export view with its data' })).toBeInTheDocument()
    expect(startViewPackage).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Export something else' }))
    expect(await screen.findByRole('button', { name: /Download/ })).toBeInTheDocument()
    expect(tracked()).toBeDefined()                        // still being built: the tray shows it
  })

  it('cancels the package being built, asked once more first', async () => {
    building({ phase: 'data', summary: { nodes: 10, edges: 5, bytes: 100 } })
    vi.mocked(cancelExport).mockResolvedValue({ jobId: 'exp_1', jobType: 'export', graphId: 'g1', status: 'cancelled' })
    renderDialog()
    await chooseData()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await screen.findByText(/Writing the data…/)

    await userEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    await userEvent.click(screen.getByRole('button', { name: 'Stop export' }))
    expect(cancelExport).toHaveBeenCalledWith('ws1', 'g1', 'exp_1')
    expect(await screen.findByText('Export cancelled')).toBeInTheDocument()
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
  })

  it('asks again under the same request id when the answer to starting it was lost', async () => {
    vi.mocked(startViewPackage).mockReset()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(STARTED)
    building({ phase: 'bundle' })
    renderDialog()
    await chooseData()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))

    expect(await screen.findByText('Failed to fetch')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await screen.findByText('Packing the views…')
    const [first, second] = vi.mocked(startViewPackage).mock.calls
    expect(second[1].requestId).toBe(first[1].requestId)
  })

  it('opens on the view with its data when asked (the canvas’s “Export view + data…”)', async () => {
    resolveGraphMock.mockReset()
    resolveGraphMock.mockResolvedValue({ graphId: 'g1', mainBranchId: 'main', mainHeadCommitSeq: 9, myDraft: null })
    renderDialog({ initialContent: 'data' })
    expect(await screen.findByText('finance-lineage.v3.view-package.zip')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /View \+ data/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('says why the data can’t come along from a data source without version control', async () => {
    resolveGraphMock.mockReset()
    resolveGraphMock.mockRejectedValue(new Error('404 no versioned graph for data source'))
    renderDialog()
    expect(await screen.findByText(/Only a data source under version control can be packaged/)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /View \+ data/ })).toBeDisabled()
    expect(screen.getByRole('radio', { name: /View only/ })).toHaveAttribute('aria-checked', 'true')
  })
})
