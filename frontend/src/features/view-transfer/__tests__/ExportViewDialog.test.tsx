/**
 * ExportViewDialog pins:
 *   - every export names a real version: unsaved changes are announced as the version they
 *     will become, and the note typed for it travels with the request;
 *   - an earlier version exports exactly that version;
 *   - several views go up in one request, each at its current design;
 *   - the result shows the file's name and fingerprint; a failure says why and can be retried;
 *   - a selection over the server's per-file cap can't be sent.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewVersionPage, ViewVersionSummary } from '@/services/viewVersionsApiService'

vi.mock('@/services/viewTransferApiService', () => ({ exportViews: vi.fn() }))
vi.mock('@/services/viewVersionsApiService', () => ({
  listViewVersions: vi.fn(),
  getViewVersionStatus: vi.fn(),
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

import { exportViews } from '@/services/viewTransferApiService'
import { getViewVersionStatus, listViewVersions } from '@/services/viewVersionsApiService'
import { ExportViewDialog } from '../ExportViewDialog'

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
    vi.mocked(getViewVersionStatus).mockReset()
  })

  it('announces unsaved changes as the version they become, and sends the note', async () => {
    vi.mocked(listViewVersions).mockResolvedValue(page(true))
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
    vi.mocked(getViewVersionStatus).mockImplementation(async (id: string) => ({
      headVersion: 5, headHash: 'h', workingHash: id === 'b' ? 'x' : 'h', designChanged: id === 'b',
      labelChanged: false, dirty: id === 'b',
    }))
    vi.mocked(exportViews).mockResolvedValue({
      filename: '2-views.view.json', bytes: 100, bundleHash: 'sha256:set', definitionHash: null, version: null,
    })
    renderDialog([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }])

    expect(screen.getByText('Export 2 views')).toBeInTheDocument()
    expect(await screen.findByText('v5 + changes → v6')).toBeInTheDocument()
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
    vi.mocked(getViewVersionStatus).mockResolvedValue({
      headVersion: 1, headHash: 'h', workingHash: 'h', designChanged: false, labelChanged: false, dirty: false,
    })
    renderDialog(Array.from({ length: 201 }, (_, i) => ({ id: `v${i}`, name: `View ${i}` })))
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled()
    expect(screen.getByText(/A file holds up to 200 views/)).toBeInTheDocument()
  })
})
