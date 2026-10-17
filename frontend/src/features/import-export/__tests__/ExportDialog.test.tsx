/**
 * ExportDialog pins:
 *   - it asks what the export would hold before exporting; a data source with version control's
 *     export is then prepared on the server, named for the data source (and the view, and the
 *     draft), with the scope and version chosen, and downloaded once its file is ready;
 *   - while the server prepares it, the dialog says where it waits in the queue and how far it has
 *     got (its steps, records, percent), that it resumed where it left off when a server took it
 *     over, and that the download starts by itself; closed meanwhile, the export carries on and
 *     downloads by itself once ready, and the dialog opened again shows it; one that has ended
 *     isn't opened on; exporting something else leaves it carrying on;
 *   - the export can be cancelled while it is prepared, asked once more first;
 *   - an export that would hold nothing says why, in the terms it was chosen in, and downloads
 *     nothing: no empty files;
 *   - an export too large for Excel says so and offers CSV, which then exports;
 *   - a data source without version control exports its live graph, streamed, with no view or
 *     version to choose, in view mode as in edit mode;
 *   - new property columns are offered only for the spreadsheet formats;
 *   - a failure says why and can be retried.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportPlan, Job } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  planExport: vi.fn(),
  createExport: vi.fn(),
  getExport: vi.fn(),
  cancelExport: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

import { cancelExport, createExport, getExport, planExport, triggerBrowserDownload } from '@/services/importExportApiService'
import { dismissExport, exportStage, trackExport, useBackgroundExports } from '../backgroundExports'
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

/** An export of this data source started earlier, as the app follows it (the dialog since closed). */
function startedEarlier() {
  trackExport({ jobId: 'j9', kind: 'data', wsId: 'ws1', graphId: 'g1', fileName: 'Finance-DWH.csv',
    label: 'Finance DWH · CSV', format: 'csv', total: 4000, exact: true })
}

const tracked = (jobId: string) => useBackgroundExports.getState().exports.find((e) => e.jobId === jobId)

beforeEach(() => {
  localStorage.clear()
  vi.mocked(planExport).mockReset()
  vi.mocked(createExport).mockReset().mockResolvedValue({ jobId: 'j1', resultUri: 'r', status: 'pending' })
  vi.mocked(getExport).mockReset().mockResolvedValue(exportJob())
  vi.mocked(cancelExport).mockReset()
  vi.mocked(triggerBrowserDownload).mockReset()
})

afterEach(() => {
  for (const e of useBackgroundExports.getState().exports) dismissExport(e.jobId)
  useBackgroundExports.setState({ exports: [], shown: [] })
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
    expect(useBackgroundExports.getState().shown).toEqual(['j1'])       // the tray leaves it to the dialog

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
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'pending', queuedAhead: 2, summary: null }))
    startedEarlier()
    const { unmount } = open()

    await screen.findByText('Waiting to start…')
    expect(screen.getByText('2 jobs are ahead of it.')).toBeInTheDocument()
    expect(screen.getByText('Waiting its turn')).toBeInTheDocument()
    expect(screen.getByText('Finance-DWH.csv')).toBeInTheDocument()
    expect(getExport).toHaveBeenCalledWith('ws1', 'g1', 'j9')
    expect(planExport).not.toHaveBeenCalled()
    unmount()
    expect(tracked('j9')).toBeDefined()                            // closed: it carries on

    // A spreadsheet reads every record for its columns first: halfway through writing is 62%.
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'running',
      summary: { nodes: 1000, edges: 0, passes: 2, bytes: 2048 } }))
    await waitFor(() => expect(tracked('j9')?.job?.status).toBe('running'), { timeout: 3000 })
    open()
    await screen.findByText('Writing the file… 1,000 of 4,000 records, 2.0 KB')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62')
  })

  it('shows the export as it goes: its steps, what it has written, and that the download starts by itself', async () => {
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'running', attempt: 2,
      summary: { nodes: 1000, edges: 0, passes: 2, bytes: 2048 } }))
    startedEarlier()
    open()

    await screen.findByText('Writing the file… 1,000 of 4,000 records, 2.0 KB')
    expect(screen.getByText('Resumed where it left off (attempt 2).')).toBeInTheDocument()
    expect(screen.getByText('Step 3 of 4 · Writing the file')).toBeInTheDocument()
    const steps = screen.getByRole('list', { name: 'Export steps' })
    expect(within(steps).getAllByRole('listitem').map((li) => li.textContent))
      .toEqual(['Queued', 'Finding the columns', 'Writing the file', 'Download'])
    expect(within(steps).getByText('Writing the file').closest('li')).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('1,000')).toBeInTheDocument()
    expect(screen.getByText('Entities')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByText(/Your download starts automatically/)).toBeInTheDocument()
  })

  it('downloads the export by itself once ready, its dialog closed meanwhile', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    vi.mocked(getExport).mockResolvedValue(exportJob({ status: 'running', summary: null }))
    const { unmount } = open()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
    await screen.findByText(/Your download starts automatically/)
    unmount()
    expect(useBackgroundExports.getState().shown).toEqual([])        // the tray shows it now

    vi.mocked(getExport).mockResolvedValue(exportJob())
    await waitFor(() => expect(triggerBrowserDownload).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(downloaded()[0].pathname).toBe('/api/v1/ws1/versioning/graphs/g1/exports/j1/download')
    expect(exportStage(tracked('j1')!)).toBe('downloaded')
  })

  it('opens on the choices when the export it last showed has ended', async () => {
    for (const gone of [exportJob({ jobId: 'j9', status: 'failed', errorMessage: 'boom' }), exportJob({ jobId: 'j9', kept: false })]) {
      vi.mocked(getExport).mockResolvedValue(gone)
      startedEarlier()
      await waitFor(() => expect(tracked('j9')?.endedAt).toEqual(expect.any(Number)))
      const { unmount } = open()
      await screen.findByRole('button', { name: /Export CSV/ })
      expect(triggerBrowserDownload).not.toHaveBeenCalled()
      unmount()
      dismissExport('j9')
    }
  })

  it('exports something else instead, the one being prepared carrying on', async () => {
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'running', summary: null }))
    startedEarlier()
    open()
    await screen.findByText('Starting…')
    await userEvent.click(screen.getByRole('button', { name: /Export something else/ }))

    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeInTheDocument()
    expect(tracked('j9')).toBeDefined()
    expect(useBackgroundExports.getState().shown).toEqual([])
  })

  it('cancels the export being prepared, asked once more first', async () => {
    vi.mocked(getExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'running', summary: null }))
    vi.mocked(cancelExport).mockResolvedValue(exportJob({ jobId: 'j9', status: 'cancelled' }))
    startedEarlier()
    open()
    await screen.findByText('Starting…')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel export' }))
    await userEvent.click(screen.getByRole('button', { name: 'Stop export' }))
    expect(cancelExport).toHaveBeenCalledWith('ws1', 'g1', 'j9')
    expect(await screen.findByText('Export cancelled')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was downloaded/)).toBeInTheDocument()
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
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
    // A failed poll is asked again (the export runs on regardless) until the export has gone
    // unanswered for two minutes: only then has the dialog lost touch with it.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(planExport).mockResolvedValue(plan())
      vi.mocked(getExport).mockRejectedValue(new Error('Failed to fetch'))
      open()
      await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
      await vi.advanceTimersByTimeAsync(125_000)

      await screen.findByText('Lost touch with the export')
      vi.mocked(getExport).mockResolvedValue(exportJob())
      await userEvent.click(screen.getByRole('button', { name: /Try again/ }))
      await screen.findByText('Your download has started')
      expect(createExport).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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
