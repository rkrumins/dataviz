/**
 * ExportDialog pins:
 *   - it asks what the export would hold before downloading, and downloads the stream itself,
 *     named for the data source (and the view, and the draft), with the scope and version chosen;
 *   - an export that would hold nothing says why, in the terms it was chosen in, and downloads
 *     nothing: no empty files;
 *   - an export too large for Excel says so and offers CSV, which then downloads;
 *   - a data source without version control exports its live graph, with no view or version to
 *     choose, in view mode as in edit mode;
 *   - new property columns are offered only for the spreadsheet formats;
 *   - a failure says why and can be retried.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportPlan } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  planExport: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))
vi.mock('@/services/telemetryService', () => ({ recordEvent: vi.fn() }))

import { planExport, triggerBrowserDownload } from '@/services/importExportApiService'
import { ExportDialog, type ExportDialogProps } from '../ExportDialog'

function plan(extra: Partial<ExportPlan> = {}): ExportPlan {
  return { format: 'csv', nodes: 1200, edges: 3400, exact: true, empty: false, formatLimit: null, view: null, ...extra }
}

function open(props: Partial<ExportDialogProps> = {}) {
  return render(
    <ExportDialog wsId="ws1" dataSourceId="ds1" graphId="g1" dataSourceName="Finance DWH"
      viewId="v1" viewName="Revenue lineage" onClose={() => {}} {...props} />,
  )
}

/** The URL the browser was sent to, parsed. */
function downloaded(): URL {
  const [url] = vi.mocked(triggerBrowserDownload).mock.calls.at(-1)!
  return new URL(url, 'http://app')
}

beforeEach(() => {
  vi.mocked(planExport).mockReset()
  vi.mocked(triggerBrowserDownload).mockReset()
})

describe('ExportDialog', () => {
  it('checks the export, then downloads the stream for the chosen view, version and format', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    open({ branchId: 'br1' })
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Your download has started')
    expect(planExport).toHaveBeenCalledWith(
      { wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', viewId: 'v1', branchId: 'br1' }, 'csv')
    const url = downloaded()
    expect(url.pathname).toBe('/api/v1/ws1/versioning/graphs/g1/exports/stream')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      format: 'csv', viewId: 'v1', branchId: 'br1', filename: 'Finance-DWH-Revenue-lineage-draft' })
    expect(vi.mocked(triggerBrowserDownload).mock.calls[0][1]).toBe('Finance-DWH-Revenue-lineage-draft.csv')
    expect(screen.getByText(/1,200 entities and 3,400 relationships/)).toBeInTheDocument()
  })

  it('names the file once when the view is named like its data source', async () => {
    vi.mocked(planExport).mockResolvedValue(plan())
    open({ dataSourceName: 'Finance lineage', viewName: 'Finance lineage' })
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Your download has started')
    expect(vi.mocked(triggerBrowserDownload).mock.calls[0][1]).toBe('Finance-lineage.csv')
  })

  it('exports the published whole data source when chosen', async () => {
    vi.mocked(planExport).mockResolvedValue(plan({ format: 'ndjson' }))
    open({ branchId: 'br1' })
    await userEvent.click(screen.getByText('Whole data source'))
    await userEvent.click(screen.getByText('Published'))
    await userEvent.click(screen.getByText('NDJSON'))
    await userEvent.click(screen.getByRole('button', { name: /Export NDJSON/ }))

    await screen.findByText('Your download has started')
    expect(planExport).toHaveBeenCalledWith(
      { wsId: 'ws1', dataSourceId: 'ds1', graphId: 'g1', viewId: undefined, branchId: undefined }, 'ndjson')
    expect(downloaded().searchParams.has('viewId')).toBe(false)
    expect(downloaded().searchParams.has('branchId')).toBe(false)
  })

  it('never downloads an empty file: it says why there is nothing to export', async () => {
    vi.mocked(planExport).mockResolvedValue(plan({
      nodes: 0, edges: 0, empty: true, view: { viewId: 'v1', placements: 12, found: 0, entities: 0 } }))
    open()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Nothing to export')
    expect(screen.getByText(/None of the 12 entities this view places are in this data source/)).toBeInTheDocument()
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
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV instead/ }))
    await screen.findByText('Your download has started')
    expect(downloaded().searchParams.get('format')).toBe('csv')
  })

  it('exports the live graph of a data source without version control', async () => {
    vi.mocked(planExport).mockResolvedValue(plan({ exact: false }))
    open({ graphId: null, branchId: undefined })
    expect(screen.queryByText('This view')).not.toBeInTheDocument()
    expect(screen.queryByText('Which version')).not.toBeInTheDocument()
    expect(screen.getByText(/has no version control/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Export CSV/ }))

    await screen.findByText('Your download has started')
    expect(planExport).toHaveBeenCalledWith(
      { wsId: 'ws1', dataSourceId: 'ds1', graphId: null, viewId: undefined, branchId: undefined }, 'csv')
    const url = downloaded()
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
    expect(downloaded().searchParams.get('props')).toBe('Owner,PII')
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
