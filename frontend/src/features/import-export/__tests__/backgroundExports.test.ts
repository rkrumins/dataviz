/**
 * backgroundExports pins:
 *   - an export started is followed until it ends, and its file downloads by itself once ready —
 *     once: a tab finding it downloaded by another downloads nothing; one that failed or is no
 *     longer kept downloads nothing, and says so;
 *   - a cancel asks the server, records where the export ended, and stops following it; one that
 *     finished before the cancel reached the server is not downloaded by itself; a refused cancel
 *     leaves it as it was — and downloads it, should it have finished meanwhile;
 *   - an export the server refuses to answer about is lost touch with, and followed again on asking;
 *   - exports are kept in this browser, each under its own key: a new visit follows the signed-in
 *     person's that haven't ended, never another person's, and lets go of those past the day their
 *     files are kept; another tab's start and dismissal arrive through the `storage` event;
 *   - while a dialog shows an export the tray leaves it out, and one the dialog saw end is let go of;
 *   - how far an export has got, and the steps it goes through, by kind and format.
 */
import { act, renderHook } from '@testing-library/react'
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
import {
  cancelBackgroundExport, dismissExport, exportProgress, exportStage, exportSteps, findRunningExport, retryExport,
  runBackgroundExports, trackExport, useBackgroundExports, useShownExport, type BackgroundExport, type NewExport,
} from '../backgroundExports'

const START: NewExport = {
  jobId: 'j1', kind: 'data', wsId: 'ws1', graphId: 'g1', fileName: 'Finance-DWH.csv', label: 'Finance DWH · CSV',
  format: 'csv', total: 4000, exact: true,
}

function job(extra: Partial<Job> = {}): Job {
  return { jobId: 'j1', jobType: 'export', graphId: 'g1', status: 'completed', kept: true,
    summary: { nodes: 1200, edges: 2800, bytes: 4096 }, ...extra }
}

const exported = (jobId = 'j1') => useBackgroundExports.getState().exports.find((e) => e.jobId === jobId)!
const signIn = (id: string | null) =>
  useAuthStore.setState({ user: id ? ({ id } as ReturnType<typeof useAuthStore.getState>['user']) : null })

let stop: (() => void) | null = null

beforeEach(() => {
  localStorage.clear()
  signIn(null)
  vi.mocked(getExport).mockReset().mockResolvedValue(job())
  vi.mocked(cancelExport).mockReset()
  vi.mocked(triggerBrowserDownload).mockReset()
})

afterEach(() => {
  stop?.()
  stop = null
  for (const e of useBackgroundExports.getState().exports) dismissExport(e.jobId)
  useBackgroundExports.setState({ exports: [], shown: [] })
})

describe('following an export', () => {
  it('downloads its file by itself once it is ready, once', async () => {
    trackExport(START)
    await vi.waitFor(() => expect(exportStage(exported())).toBe('downloaded'))
    expect(getExport).toHaveBeenCalledWith('ws1', 'g1', 'j1')
    expect(triggerBrowserDownload).toHaveBeenCalledTimes(1)
    expect(triggerBrowserDownload).toHaveBeenCalledWith('/api/v1/ws1/versioning/graphs/g1/exports/j1/download', 'Finance-DWH.csv')
    expect(exported().downloadedAt).toEqual(expect.any(Number))

    trackExport(START)                                   // asked again: the one already kept
    await Promise.resolve()
    expect(triggerBrowserDownload).toHaveBeenCalledTimes(1)
  })

  it('downloads nothing when another tab already did', async () => {
    localStorage.setItem('background-export-downloaded:j1', '1700000000000')
    trackExport(START)
    await vi.waitFor(() => expect(exportStage(exported())).toBe('downloaded'))
    expect(exported().downloadedAt).toBe(1700000000000)
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
  })

  it('downloads nothing for an export that failed or is no longer kept', async () => {
    vi.mocked(getExport).mockResolvedValueOnce(job({ status: 'failed', errorMessage: 'The worker stopped.' }))
    trackExport(START)
    await vi.waitFor(() => expect(exportStage(exported())).toBe('failed'))

    vi.mocked(getExport).mockResolvedValueOnce(job({ jobId: 'j2', kept: false }))
    trackExport({ ...START, jobId: 'j2' })
    await vi.waitFor(() => expect(exportStage(exported('j2'))).toBe('expired'))
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
    expect(exported('j2').endedAt).toEqual(expect.any(Number))
  })

  it('loses touch with an export the server refuses to answer about, and follows it again on asking', async () => {
    vi.mocked(getExport).mockRejectedValueOnce(Object.assign(new Error('export not found'), { status: 404 }))
    trackExport(START)
    await vi.waitFor(() => expect(exportStage(exported())).toBe('lost'))
    expect(exported().lost).toBe('export not found')

    retryExport('j1')
    await vi.waitFor(() => expect(exportStage(exported())).toBe('downloaded'))
  })
})

describe('cancelling an export', () => {
  it('asks the server, records where it ended, and stops following it', async () => {
    vi.mocked(getExport).mockResolvedValue(job({ status: 'running', summary: null }))
    vi.mocked(cancelExport).mockResolvedValue(job({ status: 'cancelled' }))
    trackExport(START)
    await vi.waitFor(() => expect(exportStage(exported())).toBe('running'))

    await cancelBackgroundExport('j1')
    expect(cancelExport).toHaveBeenCalledWith('ws1', 'g1', 'j1')
    expect(exportStage(exported())).toBe('cancelled')
    const asked = vi.mocked(getExport).mock.calls.length
    await new Promise((r) => setTimeout(r, 1100))
    expect(vi.mocked(getExport).mock.calls.length).toBe(asked)
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
  })

  it('leaves one that finished before the cancel reached the server for the person to download', async () => {
    vi.mocked(getExport).mockResolvedValue(job({ status: 'running', summary: null }))
    vi.mocked(cancelExport).mockResolvedValue(job())
    trackExport(START)
    await vi.waitFor(() => expect(exportStage(exported())).toBe('running'))

    await cancelBackgroundExport('j1')
    expect(exportStage(exported())).toBe('ready')
    expect(exported().cancelRequested).toBe(true)
    expect(triggerBrowserDownload).not.toHaveBeenCalled()
  })

  it('leaves it as it was when the server refuses, downloading it should it have finished meanwhile', async () => {
    let finish: (j: Job) => void = () => {}
    vi.mocked(getExport).mockResolvedValueOnce(job({ status: 'running', summary: null }))
      .mockImplementation(() => new Promise<Job>((resolve) => { finish = resolve }))
    trackExport(START)
    await vi.waitFor(() => expect(exportStage(exported())).toBe('running'))

    let refuse: (e: Error) => void = () => {}
    vi.mocked(cancelExport).mockImplementation(() => new Promise<Job>((_, reject) => { refuse = reject }))
    const cancelling = cancelBackgroundExport('j1')
    await vi.waitFor(() => expect(getExport).toHaveBeenCalledTimes(2), { timeout: 3000 })
    finish(job())                                        // it finished while the cancel was asked for
    await vi.waitFor(() => expect(exportStage(exported())).toBe('ready'))
    expect(triggerBrowserDownload).not.toHaveBeenCalled()

    refuse(new Error('Only the person who started this export, or a manager, can cancel it.'))
    await expect(cancelling).rejects.toThrow('Only the person who started this export')
    expect(exported().cancelRequested).toBe(false)
    await vi.waitFor(() => expect(triggerBrowserDownload).toHaveBeenCalledTimes(1))
  })
})

describe('kept in this browser', () => {
  function keep(e: Partial<BackgroundExport> & { jobId: string }) {
    const full: BackgroundExport = {
      kind: 'data', wsId: 'ws1', graphId: 'g1', userId: 'usr_a', fileName: `${e.jobId}.csv`, label: 'Finance DWH',
      startedAt: Date.now(), job: null, endedAt: null, downloadedAt: null, ...e,
    }
    localStorage.setItem(`background-export:${e.jobId}`, JSON.stringify(full))
  }

  it('follows, on a new visit, the signed-in person’s exports that haven’t ended, and lets go of old ones', async () => {
    signIn('usr_a')
    vi.mocked(getExport).mockResolvedValue(job({ status: 'running', summary: null }))
    keep({ jobId: 'mine' })
    keep({ jobId: 'theirs', userId: 'usr_b' })
    keep({ jobId: 'ended', job: job({ jobId: 'ended', status: 'failed' }) })
    keep({ jobId: 'old', startedAt: Date.now() - 25 * 3600 * 1000 })
    stop = runBackgroundExports()

    await vi.waitFor(() => expect(exportStage(exported('mine'))).toBe('running'))
    expect(vi.mocked(getExport).mock.calls.map((c) => c[2])).toEqual(['mine'])
    expect(useBackgroundExports.getState().exports.map((e) => e.jobId).sort()).toEqual(['ended', 'mine', 'theirs'])
    expect(localStorage.getItem('background-export:old')).toBeNull()
    expect(findRunningExport((e) => e.kind === 'data')?.jobId).toBe('mine')
  })

  it('keeps each export under its own key, and hears of other tabs’ through the storage event', async () => {
    signIn('usr_a')
    vi.mocked(getExport).mockResolvedValue(job({ jobId: 'other', status: 'running', summary: null }))
    stop = runBackgroundExports()
    trackExport(START)
    expect(JSON.parse(localStorage.getItem('background-export:j1')!)).toMatchObject({ jobId: 'j1', userId: 'usr_a' })

    const theirs = { ...exported(), jobId: 'other', startedAt: Date.now() + 1 }
    window.dispatchEvent(new StorageEvent('storage', { key: 'background-export:other', newValue: JSON.stringify(theirs) }))
    await vi.waitFor(() => expect(getExport).toHaveBeenCalledWith('ws1', 'g1', 'other'))
    expect(useBackgroundExports.getState().exports[0].jobId).toBe('other')

    window.dispatchEvent(new StorageEvent('storage', { key: 'background-export:other', newValue: null }))
    expect(useBackgroundExports.getState().exports.map((e) => e.jobId)).not.toContain('other')
  })
})

describe('shown by a dialog', () => {
  it('is left out of the tray while shown, and let go of once the dialog that saw it end closes', async () => {
    vi.mocked(getExport).mockResolvedValue(job({ status: 'failed', errorMessage: 'boom' }))
    trackExport(START)
    const { unmount } = renderHook(() => useShownExport('j1'))
    expect(useBackgroundExports.getState().shown).toEqual(['j1'])
    await vi.waitFor(() => expect(exportStage(exported())).toBe('failed'))

    act(() => unmount())
    expect(useBackgroundExports.getState().shown).toEqual([])
    expect(useBackgroundExports.getState().exports).toEqual([])
  })
})

describe('how far an export has got', () => {
  const at = (extra: Partial<BackgroundExport>): BackgroundExport => ({
    ...START, userId: null, startedAt: 0, job: null, endedAt: null, downloadedAt: null, ...extra,
  })

  it('reads a spreadsheet’s two passes, and a package’s steps', () => {
    const running = (summary: object, extra: Partial<Job> = {}) => job({ status: 'running', summary: summary as Job['summary'], ...extra })
    expect(exportProgress(at({ job: running({ nodes: 1000, edges: 0, passes: 1, bytes: 3 }) })))
      .toEqual({ label: 'Finding the columns… 1,000 of 4,000 records read', pct: 12 })
    expect(exportProgress(at({ job: running({ nodes: 1000, edges: 0, passes: 2, bytes: 2048 }) })))
      .toEqual({ label: 'Writing the file… 1,000 of 4,000 records, 2.0 KB', pct: 62 })
    expect(exportSteps(at({ job: running({ nodes: 1, edges: 0, passes: 2, bytes: 1 }) })))
      .toEqual({ steps: ['Queued', 'Finding the columns', 'Writing the file', 'Download'], current: 2 })
    expect(exportSteps(at({ format: 'ndjson', job: running({ nodes: 1, edges: 0, passes: 1, bytes: 1 }) })).steps)
      .toEqual(['Queued', 'Writing the file', 'Download'])
    expect(exportProgress(at({ job: job({ status: 'pending', queuedAhead: 2 }) }))).toEqual({ label: 'Waiting to start…', pct: null })

    const pkg = at({ kind: 'package', format: undefined, total: null })
    expect(exportSteps({ ...pkg, job: running({ nodes: 5, edges: 7, bytes: 9 }, { phase: 'data' }) }))
      .toEqual({ steps: ['Queued', 'Packing the views', 'Writing the data', 'Download'], current: 2 })
    expect(exportProgress({ ...pkg, job: running({ nodes: 1200, edges: 800, bytes: 9 }, { phase: 'data' }) }))
      .toEqual({ label: 'Writing the data… 1,200 entities and 800 relationships so far', pct: null })
    expect(exportSteps({ ...pkg, job: job() }).current).toBe(4)
  })
})
