/**
 * ExportViewDialog pins:
 *   - every export names a real version: unsaved changes are announced as the version they
 *     will become, and the note typed for it travels with the request;
 *   - an earlier version exports exactly that version;
 *   - several views go up in one request, each at its current design, and what they would go out
 *     as is read in one request too, with the file's totals and an estimated size;
 *   - someone who can't edit a view exports its latest version: their export saves nothing;
 *   - the result shows the file's name and fingerprint; a failure says why and can be retried;
 *   - a selection over the server's per-file cap can't be sent.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewVersionPage, ViewVersionSummary } from '@/services/viewVersionsApiService'
import type { ExportPreview } from '@/services/viewTransferApiService'

vi.mock('@/services/viewTransferApiService', () => ({ exportViews: vi.fn(), previewExport: vi.fn() }))
vi.mock('@/services/viewVersionsApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/viewVersionsApiService')>(),
  listViewVersions: vi.fn(),
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

import { exportViews, previewExport } from '@/services/viewTransferApiService'
import { listViewVersions } from '@/services/viewVersionsApiService'
import { ExportViewDialog } from '../ExportViewDialog'

function preview(viewId: string, extra: Partial<ExportPreview> = {}): ExportPreview {
  return {
    viewId, name: 'Finance lineage', workspaceId: 'ws1', dataSourceId: null, headVersion: 3, dirty: false,
    maySeal: true, exportsAs: 3, includesUnsaved: false,
    stats: { layers: 3, assignments: 120, rules: 4, displayRules: 1 }, estimatedBytes: 20_480, ...extra,
  }
}

/** The preview answers for whichever views it is asked about, from `byId` when given. */
function previewing(byId: Record<string, Partial<ExportPreview>> = {}) {
  vi.mocked(previewExport).mockImplementation(async (ids: string[]) => ({ views: ids.map((id) => preview(id, byId[id])) }))
}

function version(n: number, extra: Partial<ViewVersionSummary> = {}): ViewVersionSummary {
  return {
    version: n, contentHash: `sha256:${n}`, name: 'Finance lineage', tags: [], source: 'wizard',
    stats: { layers: 3, assignments: 120, rules: 4, displayRules: 1 },
    createdAt: new Date().toISOString(), createdByName: 'Dana', ...extra,
  }
}

function page(dirty: boolean): ViewVersionPage {
  return {
    items: [version(3), version(2, { source: 'import', message: 'From dev' }), version(1, { source: 'create' })],
    hasMore: false, nextBefore: null, portableId: 'pv_1',
    workingCopy: {
      headVersion: 3, headHash: 'sha256:3', workingHash: dirty ? 'sha256:x' : 'sha256:3',
      designChanged: dirty, labelChanged: false, dirty,
    },
  }
}

function renderDialog(views = [{ id: 'view_1', name: 'Finance lineage' }], onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ExportViewDialog views={views} onClose={onClose} />
    </QueryClientProvider>,
  )
  return { onClose }
}

describe('ExportViewDialog', () => {
  beforeEach(() => {
    vi.mocked(exportViews).mockReset()
    vi.mocked(listViewVersions).mockReset()
    vi.mocked(previewExport).mockReset()
    previewing()
  })

  it('announces unsaved changes as the version they become, and sends the note', async () => {
    vi.mocked(listViewVersions).mockResolvedValue(page(true))
    previewing({ view_1: { dirty: true, exportsAs: 4, includesUnsaved: true } })
    vi.mocked(exportViews).mockResolvedValue({
      filename: 'finance-lineage.v4.view.json', bytes: 2048, bundleHash: 'sha256:bundle',
      definitionHash: 'sha256:abcdef0123456789abcdef', version: 4,
    })
    renderDialog()

    expect(await screen.findByText('The current design, as v4')).toBeInTheDocument()
    expect(screen.getByText('finance-lineage.v4.view.json')).toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText(/Note for v4/), 'For UAT')
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))

    expect(exportViews).toHaveBeenCalledWith([{ viewId: 'view_1', version: null }], 'For UAT')
    expect(await screen.findByText('Downloaded')).toBeInTheDocument()
    expect(screen.getByText('finance-lineage.v4.view.json')).toBeInTheDocument()
    expect(screen.getByText('abcdef0123456789')).toBeInTheDocument()
  })

  it('exports exactly the earlier version picked', async () => {
    vi.mocked(listViewVersions).mockResolvedValue(page(false))
    vi.mocked(exportViews).mockResolvedValue({
      filename: 'finance-lineage.v2.view.json', bytes: 100, bundleHash: null, definitionHash: 'sha256:2', version: 2,
    })
    renderDialog()

    expect(await screen.findByText('The current design · v3')).toBeInTheDocument()
    await userEvent.click(screen.getByText('An earlier version'))
    await userEvent.selectOptions(screen.getByLabelText('Version to export'), '1')
    expect(screen.getByText('finance-lineage.v1.view.json')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))

    expect(exportViews).toHaveBeenCalledWith([{ viewId: 'view_1', version: 1 }], undefined)
  })

  it('sends several views in one file, each at its current design', async () => {
    previewing({
      a: { headVersion: 5, exportsAs: 5 },
      b: { headVersion: 5, dirty: true, exportsAs: 6, includesUnsaved: true },
    })
    vi.mocked(exportViews).mockResolvedValue({
      filename: '2-views.view.json', bytes: 100, bundleHash: 'sha256:set', definitionHash: null, version: null,
    })
    renderDialog([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }])

    expect(screen.getByText('Export 2 views')).toBeInTheDocument()
    expect(await screen.findByText('v5 + changes → v6')).toBeInTheDocument()
    // One request for every view's state, however many there are, and the file's totals.
    expect(previewExport).toHaveBeenCalledTimes(1)
    expect(previewExport).toHaveBeenCalledWith(['a', 'b'])
    expect(screen.getByText('240')).toBeInTheDocument()
    expect(screen.getByText('about 40.0 KB')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    expect(exportViews).toHaveBeenCalledWith([{ viewId: 'a', version: null }, { viewId: 'b', version: null }], undefined)
    expect(await screen.findByText('Downloaded')).toBeInTheDocument()
  })

  it('says why an export failed, and lets it be tried again', async () => {
    vi.mocked(listViewVersions).mockResolvedValue(page(false))
    vi.mocked(exportViews).mockRejectedValueOnce(new Error('Exporting views is turned off'))
    renderDialog()

    await userEvent.click(await screen.findByRole('button', { name: /Download/ }))
    expect(await screen.findByText('Exporting views is turned off')).toBeInTheDocument()
    vi.mocked(exportViews).mockResolvedValueOnce({
      filename: 'f.view.json', bytes: 1, bundleHash: null, definitionHash: null, version: 3,
    })
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(exportViews).toHaveBeenCalledTimes(2))
  })

  it("won't send more views than a file can hold", async () => {
    renderDialog(Array.from({ length: 201 }, (_, i) => ({ id: `v${i}`, name: `View ${i}` })))
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled()
    expect(screen.getByText(/A file holds up to 200 views/)).toBeInTheDocument()
    expect(previewExport).not.toHaveBeenCalled()
  })

  it('has someone who can’t edit the view export its latest version, saving nothing', async () => {
    vi.mocked(listViewVersions).mockResolvedValue(page(true))
    previewing({ view_1: { dirty: true, maySeal: false, exportsAs: 3, includesUnsaved: false } })
    vi.mocked(exportViews).mockResolvedValue({
      filename: 'finance-lineage.v3.view.json', bytes: 100, bundleHash: null, definitionHash: 'sha256:3', version: 3,
    })
    renderDialog()

    expect(await screen.findByText('The latest version · v3')).toBeInTheDocument()
    expect(screen.getByText(/Changes made since v3 aren’t saved as a version yet/)).toBeInTheDocument()
    expect(screen.getByText('finance-lineage.v3.view.json')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Note for/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    expect(exportViews).toHaveBeenCalledWith([{ viewId: 'view_1', version: null }], undefined)
  })
})
