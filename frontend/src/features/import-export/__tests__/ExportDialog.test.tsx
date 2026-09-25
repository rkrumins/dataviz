/**
 * ExportDialog pins:
 *   - it asks what the export would hold before exporting; a data source with version control's
 *     export is then prepared on the server, named for the data source (and the view, and the
 *     draft), with the scope and version chosen, and downloaded once its file is ready;
 *   - while the server prepares it, the dialog says where it waits in the queue and how far it has
 *     got; closed meanwhile, it opens on that export again, and downloads it once it's ready; one
 *     that failed or is no longer kept is let go of quietly;
 *   - an export that would hold nothing says why, in the terms it was chosen in, and downloads
 *     nothing: no empty files;
 *   - an export too large for Excel says so and offers CSV, which then exports;
 *   - a data source without version control exports its live graph, streamed, with no view or
 *     version to choose, in view mode as in edit mode;
 *   - new property columns are offered only for the spreadsheet formats;
 *   - a failure says why and can be retried.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportPlan, Job } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  planExport: vi.fn(),
  createExport: vi.fn(),
  getExport: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

import { createExport, getExport, planExport, triggerBrowserDownload } from '@/services/importExportApiService'
import { ExportDialog, type ExportDialogProps } from '../ExportDialog'

function plan(extra: Partial<ExportPlan> = {}): ExportPlan {
  return { format: 'csv', nodes: 1200, edges: 3400, exact: true, empty: false, formatLimit: null, view: null, ...extra }
}

function exportJob(extra: Partial<Job> = {}): Job {
  return { jobId: 'j1', jobType: 'export', status: 'completed', graphId: 'g1', kept: true,
    summary: { nodes: 1200, edges: 3400, bytes: 5 * 1024 ** 2 }, ...extra }
}

function open(props: Partial<ExportDialogProps> = {}) {
  return render(
    <ExportDialog wsId="ws1" dataSourceId="ds1" graphId="g1" dataSourceName="Finance DWH"
      viewId="v1" viewName="Revenue lineage" onClose={() => {}} {...props} />,
  )
}

/** The URL the browser was sent to, parsed, and the file name it was given. */
function downloaded(): [URL, string] {
  const [url, name] = vi.mocked(triggerBrowserDownload).mock.calls.at(-1)!
  return [new URL(url, 'http://app'), name]
}

const REMEMBERED = 'graph-export:ws1:g1'

function remember(total: number | null = 4000) {
  localStorage.setItem(REMEMBERED, JSON.stringify({ jobId: 'j9', fileName: 'Finance-DWH.csv', format: 'csv', total, exact: true }))
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(planExport).mockReset()
  vi.mocked(createExport).mockReset().mockResolvedValue({ jobId: 'j1', resultUri: 'r', status: 'pending' })
  vi.mocked(getExport).mockReset().mockResolvedValue(exportJob())
  vi.mocked(triggerBrowserDownload).mockReset()
})

describe('ExportDialog', () => {
  it('has the server prepare the chosen view, version and format, then downloads the file', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    open({ branchId: 'br1' })
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Your download has started')
    const target = { wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', viewId: 'v1', branchId: 'br1' }
    expect(planExport).toHaveBeenCalledWith(target, 'csv')
    expect(createExport).toHaveBeenCalledWith(target, 'csv', { props: [], filename: 'Finance-DWH-Revenue-lineage-draft' })
    expect(getExport).toHaveBeenCalledWith('ws1', 'g1', 'j1')
    const [url, name] = downloaded()
    expect(url.pathname).toBe('/api/v1/ws1/versioning/graphs/g1/exports/j1/download')
    expect(name).toBe('Finance-DWH-Revenue-lineage-draft.csv')
    expect(screen.getByText(/1,200 entities and 3,400 relationships, 5.0 MB/)).toBeInTheDocument()
    expect(screen.getByText(/your browser can pick it up where it stopped/)).toBeInTheDocument()
    expect(localStorage.getItem(REMEMBERED)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /Download again/ }))
    expect(triggerBrowserDownload).toHaveBeenCalledTimes(2)
  })

  it('names the file once when the view is named like its data source', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    open({ dataSourceName: 'Finance lineage', viewName: 'Finance lineage' })
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Your download has started')
    expect(downloaded()[1]).toBe('Finance-lineage.csv')
  })

  it('exports the published whole data source when chosen', async () => {
    vi.mocked(planExport).mockResolvedValue(plan({ format: 'ndjson' }))
    open({ branchId: 'br1' })
    await userEvent.click(screen.getByText('Whole data source'))
    await userEvent.click(screen.getByText('Published'))
    await userEvent.click(screen.getByText('NDJSON'))
    await userEvent.click(screen.getByRole('button', { name: /Export NDJSON/ }))

    await screen.findByText('Your download has started')
    const target = { wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', viewId: undefined, branchId: undefined }
    expect(planExport).toHaveBeenCalledWith(target, 'ndjson')
    expect(createExport).toHaveBeenCalledWith(target, 'ndjson', { props: [], filename: 'Finance-DWH' })
  })

  it('says where a prepared export waits, and how far it has got, when the dialog opens on it again', async () => {
    remember()
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'pending', queuedAhead: 2, summary: null }))
    const { unmount } = open()

    await screen.findByText('Waiting to start…')
    expect(screen.getByText('2 jobs are ahead of it.')).toBeInTheDocument()
    expect(screen.getByText('Finance-DWH.csv')).toBeInTheDocument()
    expect(getExport).toHaveBeenCalledWith('ws1', 'g1', 'j9')
    expect(planExport).not.toHaveBeenCalled()
    unmount()
    expect(localStorage.getItem(REMEMBERED)).not.toBeNull()       // closed: it carries on

    // A spreadsheet reads every record for its columns first: halfway through writing is 62%.
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'running',
      summary: { nodes: 1000, edges: 0, passes: 2, bytes: 2048 } }))
    open()
    await screen.findByText('Writing the file… 1,000 of 4,000 records, 2.0 KB')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62')
  })

  it('downloads a prepared export that finished while the dialog was closed', async () => {
    remember()
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9' }))
    open()

    await screen.findByText('Your download has started')
    expect(downloaded()[0].pathname).toBe('/api/v1/ws1/versioning/graphs/g1/exports/j9/download')
    expect(localStorage.getItem(REMEMBERED)).toBeNull()
  })

  it('lets go quietly of a prepared export that failed or is no longer kept', async () => {
    for (const gone of [exportJob({ jobId: 'j9', status: 'failed', errorMessage: 'boom' }), exportJob({ jobId: 'j9', kept: false })]) {
      remember()
      vi.mocked(getExport).mockResolvedValue(gone)
      const { unmount } = open()
      await screen.findByRole('button', { name: /Export CSV/ })
      expect(triggerBrowserDownload).not.toHaveBeenCalled()
      expect(localStorage.getItem(REMEMBERED)).toBeNull()
      unmount()
    }
  })

  it('exports something else instead, forgetting the one being prepared', async () => {
    remember()
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'running', summary: null }))
    open()
    await screen.findByText('Starting…')
    await userEvent.click(screen.getByRole('button', { name: /Export something else/ }))

    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeInTheDocument()
    expect(localStorage.getItem(REMEMBERED)).toBeNull()
  })

  it('says why an export did not finish, and exports again', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    vi.mocked(getExport).mockResolvedValueOnce(exportJob({ status: 'failed', errorMessage: 'The worker stopped.' }))
    open()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText("The export didn't finish")
    expect(screen.getByText('The worker stopped.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await screen.findByText('Your download has started')
    expect(createExport).toHaveBeenCalledTimes(2)
  })

  it('checks again on an export it lost touch with, rather than starting another', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    vi.mocked(getExport).mockRejectedValueOnce(new Error('Failed to fetch'))
    open()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Lost touch with the export')
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await screen.findByText('Your download has started')
    expect(createExport).toHaveBeenCalledTimes(1)
  })

  it('never downloads an empty file: it says why there is nothing to export', async () => {
    vi.mocked(planExport).mockResolvedValue(plan({
      nodes: 0, edges: 0, empty: true, view: { viewId: 'v1', placements: 12, found: 0, entities: 0 } }))
    open()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Nothing to export')
    expect(screen.getByText(/None of the 12 entities this view places are in this data source/)).toBeInTheDocument()
    expect(createExport).not.toHaveBeenCalled()
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
  })

  it('offers CSV when Excel cannot hold the export', async () => {
    vi.mocked(planExport)
      .mockResolvedValueOnce(plan({ format: 'xlsx', formatLimit: 'This export has 3,000,000 nodes, more than an Excel sheet holds.' }))
      .mockResolvedValueOnce(plan({ format: 'csv' }))
    open()
    await userEvent.click(screen.getByText('Excel'))
    await userEvent.click(screen.getByRole('button', { name: /Export XLSX/ }))

    await screen.findByText('Too large for XLSX')
    expect(createExport).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV instead/ }))
    await screen.findByText('Your download has started')
    expect(vi.mocked(createExport).mock.calls[0][1]).toBe('csv')
  })

  it('exports the live graph of a data source without version control, streamed', async () => {
    vi.mocked(planExport).mockResolvedValue(plan({ exact: false }))
    open({ graphId: null, branchId: undefined })
    expect(screen.queryByText('This view')).not.toBeInTheDocument()
    expect(screen.queryByText('Which version')).not.toBeInTheDocument()
    expect(screen.getByText(/has no version control/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Your download has started')
    expect(planExport).toHaveBeenCalledWith(
      { wsId: 'ws1', dataSourceId: 'ds1', graphId: null, viewId: undefined, branchId: undefined }, 'csv')
    expect(createExport).not.toHaveBeenCalled()
    const [url] = downloaded()
    expect(url.pathname).toBe('/api/v1/ws1/graph/export/stream')
    expect(url.searchParams.get('dataSourceId')).toBe('ds1')
    expect(screen.getByText(/about 1,200 entities/)).toBeInTheDocument()
  })

  it('offers new property columns only for spreadsheets, and sends them', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    open()
    await userEvent.type(screen.getByPlaceholderText(/Owner/), 'Owner, PII')
    await userEvent.click(screen.getByText('NDJSON'))
    expect(screen.queryByPlaceholderText(/Owner/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('CSV'))
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Your download has started')
    expect(vi.mocked(createExport).mock.calls[0][2]).toMatchObject({ props: ['Owner', 'PII'] })
  })

  it('says why an export could not start, and retries', async () => {
    vi.mocked(planExport).mockRejectedValueOnce(new Error('Missing permission: workspace:datasource:read'))
      .mockResolvedValueOnce(plan())
    open()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText("The export didn't start")
    expect(screen.getByText(/Missing permission/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await waitFor(() => expect(triggerBrowserDownload).toHaveBeenCalledTimes(1))
  })
})
