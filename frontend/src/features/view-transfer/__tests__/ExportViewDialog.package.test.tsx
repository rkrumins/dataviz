/**
 * ExportViewDialog — "View + data": a view on a version-controlled data source can be packaged with
 * its graph data (its own entities or the whole source, published or as in the person's draft);
 * anywhere else the option says why it isn't there. The server builds the package: the dialog
 * says how far it has got, can be closed meanwhile (it stops following, the server carries on),
 * and opened again on the same views picks it up; a request whose answer was lost is retried under
 * the same request id.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'
import type { PackageStarted } from '@/services/viewTransferApiService'
import type { ViewVersionPage } from '@/services/viewVersionsApiService'

const resolveGraphMock = vi.fn()

vi.mock('@/services/viewTransferApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/viewTransferApiService')>(),
  exportViews: vi.fn(),
  startViewPackage: vi.fn(),
  followViewPackage: vi.fn(),
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

import { followViewPackage, startViewPackage } from '@/services/viewTransferApiService'
import { listViewVersions } from '@/services/viewVersionsApiService'
import { ExportViewDialog } from '../ExportViewDialog'

const STARTED: PackageStarted = {
  jobId: 'exp_1', graphId: 'g1', workspaceId: 'ws1', fileName: 'finance-lineage.v3.view-package.zip', status: 'pending',
  views: [{ viewId: 'view_1', version: 3 }], requestId: 'req-1',
}

/** The package's job, followed until the dialog stops following it (the server carries on). */
function building(job: Partial<Job>) {
  vi.mocked(followViewPackage).mockImplementation((_started, opts) => {
    opts?.onTick?.({ jobId: 'exp_1', jobType: 'export', graphId: 'g1', status: 'running', ...job })
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  })
}

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
    vi.mocked(followViewPackage).mockReset()
    vi.mocked(listViewVersions).mockResolvedValue(page())
    resolveGraphMock.mockReset()
    resolveGraphMock.mockResolvedValue({ graphId: 'g1', mainBranchId: 'main', mainHeadCommitSeq: 9, myDraft: { branchId: 'br_1' } })
  })

  it('packages the view with its data, from the draft when asked', async () => {
    vi.mocked(followViewPackage).mockResolvedValue({
      ...STARTED, bundleHash: 'sha256:bundle0123456789abcdef', bytes: 4096, nodes: 120, edges: 80,
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
    expect(vi.mocked(followViewPackage).mock.calls[0][0]).toEqual(STARTED)
    expect(await screen.findByText('Packaged')).toBeInTheDocument()
    expect(screen.getByText(/120 entities and 80 relationships/)).toBeInTheDocument()
  })

  it('says how far the package has got, and can be closed while the server builds it', async () => {
    building({ phase: 'data', summary: { nodes: 1200, edges: 800, bytes: 4096 }, attempt: 2 })
    const { onClose, unmount } = renderDialog()
    await chooseData()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))

    expect(await screen.findByText('Writing the data… 1,200 entities and 800 relationships so far')).toBeInTheDocument()
    expect(screen.getByText('Resumed where it left off (attempt 2).')).toBeInTheDocument()
    const footerClose = screen.getAllByRole('button', { name: 'Close' }).at(-1)!
    expect(footerClose).toBeEnabled()
    await userEvent.click(footerClose)
    expect(onClose).toHaveBeenCalled()

    const following = vi.mocked(followViewPackage).mock.calls[0][1]!.signal!
    unmount()
    expect(following.aborted).toBe(true)                    // it stops following; the server carries on
  })

  it('opens on a package the server was building when it last closed', async () => {
    localStorage.setItem('view-package:view_1', JSON.stringify(STARTED))
    building({ phase: 'bundle' })
    renderDialog()

    expect(await screen.findByText('Packing the views…')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Export view with its data' })).toBeInTheDocument()
    expect(vi.mocked(followViewPackage).mock.calls[0][0]).toEqual(STARTED)
    expect(startViewPackage).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Export something else' }))
    expect(await screen.findByRole('button', { name: /Download/ })).toBeInTheDocument()
    expect(localStorage.getItem('view-package:view_1')).toBeNull()
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
