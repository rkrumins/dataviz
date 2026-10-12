/**
 * ExportTray pins:
 *   - an export under way shows wherever the person is, as its dialog showed it: what it is doing,
 *     how far it has got (records, percent), and, up front, that the download starts by itself;
 *   - it can be cancelled from the tray, asked once more first: "Keep exporting" leaves it be,
 *     "Stop export" asks the server, and the tray then says it was cancelled;
 *   - a downloaded export says so, can be downloaded again, and dismissed;
 *   - an export an open dialog shows is left to it, and another person's never shows;
 *   - minimised, it is a pill with the overall progress, opened again by an export started later;
 *   - it reserves its height for the notification stack, and gives it back when it goes.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '@/services/importExportApiService'

vi.mock('@/services/importExportApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/importExportApiService')>(),
  getExport: vi.fn(),
  cancelExport: vi.fn(),
  triggerBrowserDownload: vi.fn(),
}))

import { cancelExport, getExport, triggerBrowserDownload } from '@/services/importExportApiService'
import { useAuthStore } from '@/store/auth'
import { dismissExport, trackExport, useBackgroundExports, type NewExport } from '../backgroundExports'
import { ExportTray } from '../ExportTray'

const START: NewExport = {
  jobId: 'j1', kind: 'data', wsId: 'ws1', graphId: 'g1', fileName: 'Finance-DWH.csv', label: 'Finance DWH · CSV',
  format: 'csv', total: 4000, exact: true,
}

function job(extra: Partial<Job> = {}): Job {
  return { jobId: 'j1', jobType: 'export', graphId: 'g1', status: 'running',
    summary: { nodes: 1000, edges: 0, passes: 2, bytes: 2048 }, ...extra }
}

const tray = () => screen.getByRole('region', { name: 'Exports' })

beforeEach(() => {
  localStorage.clear()
  useAuthStore.setState({ user: { id: 'usr_a' } as ReturnType<typeof useAuthStore.getState>['user'] })
  vi.mocked(getExport).mockReset().mockResolvedValue(job())
  vi.mocked(cancelExport).mockReset()
  vi.mocked(triggerBrowserDownload).mockReset()
})

afterEach(() => {
  for (const e of useBackgroundExports.getState().exports) dismissExport(e.jobId)
  useBackgroundExports.setState({ exports: [], shown: [] })
  useAuthStore.setState({ user: null })
  document.documentElement.style.removeProperty('--export-tray-height')
})

describe('ExportTray', () => {
  it('shows an export under way as its dialog did, and says the download starts by itself', async () => {
    render(<ExportTray />)
    expect(screen.queryByRole('region', { name: 'Exports' })).not.toBeInTheDocument()
    act(() => { trackExport(START) })

    expect(await within(tray()).findByText('Writing the file… 1,000 of 4,000 records, 2.0 KB')).toBeInTheDocument()
    expect(within(tray()).getByText('Finance-DWH.csv')).toBeInTheDocument()
    expect(within(tray()).getByText('Finance DWH · CSV')).toBeInTheDocument()
    expect(within(tray()).getByText('62%')).toBeInTheDocument()
    expect(within(tray()).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62')
    expect(within(tray()).getByText('Preparing a file')).toBeInTheDocument()
    expect(within(tray()).getByText(/Your download starts automatically when the file is ready/)).toBeInTheDocument()
  })

  it('cancels an export, asked once more first', async () => {
    vi.mocked(cancelExport).mockResolvedValue(job({ status: 'cancelled' }))
    render(<ExportTray />)
    act(() => { trackExport(START) })
    await within(tray()).findByText(/Writing the file/)

    await userEvent.click(within(tray()).getByRole('button', { name: 'Cancel export' }))
    await userEvent.click(within(tray()).getByRole('button', { name: 'Keep exporting' }))
    expect(cancelExport).not.toHaveBeenCalled()

    await userEvent.click(within(tray()).getByRole('button', { name: 'Cancel export' }))
    expect(within(tray()).getByText('Stop this export? Nothing will download.')).toBeInTheDocument()
    await userEvent.click(within(tray()).getByRole('button', { name: 'Stop export' }))
    expect(cancelExport).toHaveBeenCalledWith('ws1', 'g1', 'j1')
    expect(await within(tray()).findByText('Cancelled. Nothing was downloaded.')).toBeInTheDocument()
  })

  it('says an export downloaded, downloads it again, and lets it be dismissed', async () => {
    vi.mocked(getExport).mockResolvedValue(job({ status: 'completed', kept: true, summary: { nodes: 1, edges: 1, bytes: 5 * 1024 ** 2 } }))
    render(<ExportTray />)
    act(() => { trackExport(START) })

    expect(await within(tray()).findByText(/Downloaded · 5.0 MB/)).toBeInTheDocument()
    expect(triggerBrowserDownload).toHaveBeenCalledTimes(1)
    await userEvent.click(within(tray()).getByRole('button', { name: 'Download again' }))
    expect(triggerBrowserDownload).toHaveBeenCalledTimes(2)
    await userEvent.click(within(tray()).getByRole('button', { name: 'Dismiss Finance-DWH.csv' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Exports' })).not.toBeInTheDocument())
  })

  it('leaves out an export a dialog shows, and another person’s', async () => {
    render(<ExportTray />)
    act(() => {
      trackExport(START)
      useBackgroundExports.setState({ shown: ['j1'] })
    })
    expect(screen.queryByRole('region', { name: 'Exports' })).not.toBeInTheDocument()

    act(() => {
      useBackgroundExports.setState({ shown: [] })
      useAuthStore.setState({ user: { id: 'usr_b' } as ReturnType<typeof useAuthStore.getState>['user'] })
    })
    expect(screen.queryByRole('region', { name: 'Exports' })).not.toBeInTheDocument()
  })

  it('minimises to a pill with the overall progress, opened again by an export started later', async () => {
    render(<ExportTray />)
    act(() => { trackExport(START) })
    await within(tray()).findByText(/Writing the file/)

    await userEvent.click(screen.getByRole('button', { name: 'Minimise exports' }))
    const pill = await screen.findByRole('button', { name: 'Show exports, 1 in progress' })
    expect(pill).toHaveTextContent('Exporting · 62%')

    await new Promise((r) => setTimeout(r, 5))
    act(() => { trackExport({ ...START, jobId: 'j2', fileName: 'Revenue.csv' }) })
    const opened = await screen.findByRole('region', { name: 'Exports' })
    expect(within(opened).getByText('Revenue.csv')).toBeInTheDocument()
    expect(within(opened).getByText('Preparing 2 files')).toBeInTheDocument()
  })

  it('reserves its height for the notification stack, and gives it back when it goes', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180)
    try {
      act(() => { trackExport(START) })
      const { unmount } = render(<ExportTray />)
      await within(tray()).findByText(/Writing the file/)
      expect(document.documentElement.style.getPropertyValue('--export-tray-height')).toBe('192px')
      unmount()
      expect(document.documentElement.style.getPropertyValue('--export-tray-height')).toBe('')
    } finally {
      height.mockRestore()
    }
  })
})
