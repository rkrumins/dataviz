/**
 * FinishImportingViewsBanner — on a data source a view package made, while none of its views are
 * here and the package's upload is still kept: one click opens the Import journey on that upload
 * (no file to choose again). Not for any other data source, nor once a view is here, nor once the
 * upload is gone (or isn't the viewer's: it reads as gone).
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ViewEditorContext } from '@/components/layout/viewEditorContext'

const listMock = vi.fn()
const uploadMock = vi.fn()
vi.mock('@/services/workspaceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/workspaceService')>()
  return { ...actual, workspaceService: { ...actual.workspaceService, listDataSources: (...a: unknown[]) => listMock(...a) } }
})
vi.mock('@/services/viewTransferApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewTransferApiService')>()),
  getPackageUpload: (...a: unknown[]) => uploadMock(...a),
}))
vi.mock('../useViewPortability', () => ({ useViewPortability: () => ({ versions: true, canExport: true, canImport: true }) }))

import { FinishImportingViewsBanner } from '../FinishImportingViewsBanner'

const openViewEditor = vi.fn()
const FROM_PACKAGE = { id: 'ds_new', extraConfig: { origin: { kind: 'viewPackage', uploadId: 'up_1', requestId: 'nsr_x' } } }
const LATER = new Date(Date.now() + 3_600_000).toISOString()

function renderBanner(viewCount = 0) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ViewEditorContext.Provider value={{ openViewEditor, closeViewEditor: vi.fn() }}>
        <FinishImportingViewsBanner wsId="ws1" dataSourceId="ds_new" viewCount={viewCount} />
      </ViewEditorContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listMock.mockResolvedValue([FROM_PACKAGE])
  uploadMock.mockResolvedValue({ uploadId: 'up_1', status: 'ready', expiresAt: LATER })
})

describe('FinishImportingViewsBanner', () => {
  it('opens the Import journey on the package’s upload, for this data source', async () => {
    renderBanner()
    fireEvent.click(await screen.findByRole('button', { name: /Finish importing views/ }))
    expect(uploadMock).toHaveBeenCalledWith('up_1')
    expect(openViewEditor).toHaveBeenCalledWith(undefined, {
      journey: 'import', importUploadId: 'up_1', workspaceId: 'ws1', dataSourceId: 'ds_new',
    })
  })

  it('says nothing once a view is here', async () => {
    renderBanner(1)
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: /Finish importing views/ })).not.toBeInTheDocument()
    expect(listMock).not.toHaveBeenCalled()
  })

  it('says nothing for a data source no package made', async () => {
    listMock.mockResolvedValue([{ id: 'ds_new', extraConfig: null }])
    renderBanner()
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: /Finish importing views/ })).not.toBeInTheDocument()
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('says nothing once the upload is gone, or has run out of time', async () => {
    uploadMock.mockRejectedValueOnce(new Error('Not found'))
    const gone = renderBanner()
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: /Finish importing views/ })).not.toBeInTheDocument()
    gone.unmount()

    uploadMock.mockResolvedValue({ uploadId: 'up_1', status: 'ready', expiresAt: new Date(Date.now() - 1000).toISOString() })
    renderBanner()
    await new Promise(r => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: /Finish importing views/ })).not.toBeInTheDocument()
  })
})
