/**
 * Exports the server prepares in the background, followed app-wide until their files download.
 *
 * A large export takes minutes. Whoever starts one is free to close its dialog, go to another
 * page, or reload: the export is kept here, in this browser and for the person who started it,
 * its job is followed wherever they are in the app, and its file downloads by itself the moment it
 * is ready — once, however many tabs are open. The export tray (`ExportTray`) shows them; an
 * export dialog starts one here (`trackExport`), shows it while open, and can cancel it.
 *
 * Each export is kept under a key of its own, so two tabs never write over each other's exports,
 * and a tab hears of the exports another one starts, follows and dismisses through the browser's
 * `storage` event. Every tab follows them (a hidden one waits until it is shown: `pollJob`); the
 * first to see one finish downloads it, in a Web Lock, marking it downloaded for the others.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import {
  cancelExport, downloadExportUrl, getExport, jobProgressText, pollJob, queuePosition, remember, remembered,
  TERMINAL, triggerBrowserDownload, type ExportSummary, type ImportFormat, type Job,
} from '@/services/importExportApiService'
import { useAuthStore } from '@/store/auth'
import { prettyBytes } from './format'

export type BackgroundExportKind = 'data' | 'package'

/** An export the server prepares for this browser. */
export interface BackgroundExport {
  jobId: string
  /** A data source's data (the Export dialog), or views with their data (a view package). */
  kind: BackgroundExportKind
  wsId: string
  graphId: string
  /** Who started it. A browser can be shared: only the person signed in sees and follows theirs. */
  userId: string | null
  /** The file it downloads as. */
  fileName: string
  /** What it exports, in a few words: the data source, or the views. */
  label: string
  /** A data export's format, and the records its plan counted (`total`, null when unknown). */
  format?: ImportFormat
  total?: number | null
  exact?: boolean
  /** A package's views: a dialog opened on them again shows this one. */
  viewIds?: string[]
  startedAt: number
  /** Its job, as last seen. */
  job: Job | null
  /** When it ended, as seen here. */
  endedAt: number | null
  /** When its download started, in this tab or another. */
  downloadedAt: number | null
  /** Asked to be cancelled: a file it finished anyway is not downloaded by itself. */
  cancelRequested?: boolean
  /** Why following it stopped short of its end (the export carries on regardless). */
  lost?: string | null
}

/** What started export the dialog hands over. */
export type NewExport = Pick<BackgroundExport, 'jobId' | 'kind' | 'wsId' | 'graphId' | 'fileName' | 'label'>
  & Partial<Pick<BackgroundExport, 'format' | 'total' | 'exact' | 'viewIds' | 'job'>>

/** Where an export is: waiting its turn, being written, ready (its download about to start or, if
 *  it was asked to be cancelled, waiting to be asked for), downloaded, no longer kept, failed,
 *  cancelled, or lost touch with. */
export type ExportStage = 'queued' | 'running' | 'ready' | 'downloaded' | 'expired' | 'failed' | 'cancelled' | 'lost'

const ended = (job: Job | null | undefined) => !!job && TERMINAL.includes(job.status)

export function exportEnded(e: BackgroundExport): boolean {
  return ended(e.job)
}

/** Still being prepared: waiting its turn, or written. */
export const isWorking = (stage: ExportStage) => stage === 'queued' || stage === 'running'

export function exportStage(e: BackgroundExport): ExportStage {
  const job = e.job
  if (job && ended(job)) {
    if (job.status === 'failed') return 'failed'
    if (job.status === 'cancelled') return 'cancelled'
    if (job.kept === false) return 'expired'
    return e.downloadedAt ? 'downloaded' : 'ready'
  }
  if (e.lost) return 'lost'
  return job?.status === 'running' ? 'running' : 'queued'
}

const SPREADSHEETS: ImportFormat[] = ['xlsx', 'csv', 'tsv']
const count = (n: number) => n.toLocaleString()

/** How far an export has got, in words, and the percent done when it can be told. */
export function exportProgress(e: BackgroundExport): { label: string; pct: number | null } {
  const job = e.job
  if (queuePosition(job)) return { label: 'Waiting to start…', pct: null }
  if (e.kind === 'package') {
    return {
      label: jobProgressText(job) ?? (job?.status === 'running'
        ? 'Writing the graph data and packing it with the views…' : 'Recording the version and starting the export…'),
      pct: null,
    }
  }
  // A spreadsheet reads every record once for its columns, then again to write them.
  const passes = e.format && SPREADSHEETS.includes(e.format) ? 2 : 1
  const sofar = job?.status === 'running' ? (job.summary as ExportSummary | null) : null
  const pass = Math.min(sofar?.passes ?? 0, passes)
  const records = sofar ? sofar.nodes + sofar.edges : 0
  const of = e.total ? ` of ${e.exact ? '' : 'about '}${count(e.total)}` : ''
  const pct = pass && e.total
    ? Math.min(99, Math.floor((100 * (pass - 1 + Math.min(1, records / e.total))) / passes)) : null
  const label = jobProgressText(job)
    ?? (!sofar || !pass ? 'Starting…'
      : pass < passes ? `Finding the columns… ${count(records)}${of} records read`
        : `Writing the file… ${count(records)}${of} records, ${prettyBytes(sofar.bytes)}`)
  return { label, pct }
}

/** The steps an export goes through, and the one it is on (``steps.length`` once it is ready): a
 *  package packs its views, then writes the data; a spreadsheet reads every record for its
 *  columns, then writes them; any other file is written in one pass. */
export function exportSteps(e: BackgroundExport): { steps: string[]; current: number } {
  const job = e.job
  const steps = e.kind === 'package' ? ['Queued', 'Packing the views', 'Writing the data', 'Download']
    : e.format && SPREADSHEETS.includes(e.format) ? ['Queued', 'Finding the columns', 'Writing the file', 'Download']
      : ['Queued', 'Writing the file', 'Download']
  if (ended(job)) return { steps, current: job!.status === 'completed' ? steps.length : steps.length - 1 }
  if (job?.status !== 'running') return { steps, current: 0 }
  if (e.kind === 'package') return { steps, current: job.phase === 'data' ? 2 : 1 }
  const passes = (job.summary as ExportSummary | null)?.passes ?? 0
  return { steps, current: steps.length === 4 && passes >= 2 ? 2 : 1 }
}

/** The finished file's size, when its job says it. */
export function exportBytes(e: BackgroundExport): number | null {
  return (e.job?.summary as ExportSummary | null | undefined)?.bytes ?? null
}

// ── The store, kept in this browser ─────────────────────────────────────────

interface BackgroundExportsState {
  /** Newest first. */
  exports: BackgroundExport[]
  /** Those an open dialog shows: the tray leaves them to it. */
  shown: string[]
}

export const useBackgroundExports = create<BackgroundExportsState>(() => ({ exports: [], shown: [] }))

const KEY = 'background-export:'
const downloadedKey = (jobId: string) => `background-export-downloaded:${jobId}`
/** The server keeps an export's file for a day: one older than that is let go of. */
const KEPT_MS = 24 * 3600 * 1000

const get = (jobId: string) => useBackgroundExports.getState().exports.find((e) => e.jobId === jobId)
const currentUser = () => useAuthStore.getState().user?.id ?? null
const newestFirst = (a: BackgroundExport, b: BackgroundExport) => b.startedAt - a.startedAt

function parse(text: string | null): BackgroundExport | null {
  try {
    const e = JSON.parse(text ?? 'null') as BackgroundExport | null
    return e && typeof e.jobId === 'string' && typeof e.startedAt === 'number' ? e : null
  } catch {
    return null
  }
}

function stored(): BackgroundExport[] {
  const found: BackgroundExport[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      const e = key?.startsWith(KEY) ? parse(localStorage.getItem(key)) : null
      if (e) found.push(e)
    }
  } catch { /* no storage: nothing outlives the page */ }
  return found
}

/** Keep ``e`` in memory, and in this browser unless it came from there. */
function put(e: BackgroundExport, save = true): void {
  useBackgroundExports.setState((s) => ({
    exports: [e, ...s.exports.filter((x) => x.jobId !== e.jobId)].sort(newestFirst),
  }))
  if (save) remember(KEY + e.jobId, JSON.stringify(e))
}

function patch(jobId: string, values: Partial<BackgroundExport>): void {
  const e = get(jobId)
  if (e) put({ ...e, ...values })
}

function drop(jobId: string): void {
  useBackgroundExports.setState((s) => ({ exports: s.exports.filter((x) => x.jobId !== jobId) }))
}

/** What two tabs know of one export, together: an ended job outranks a running one, and a download
 *  or a cancel asked for in either counts. */
function merged(ours: BackgroundExport, theirs: BackgroundExport): BackgroundExport {
  return {
    ...theirs,
    job: ended(ours.job) && !ended(theirs.job) ? ours.job : theirs.job,
    endedAt: ours.endedAt ?? theirs.endedAt,
    downloadedAt: ours.downloadedAt ?? theirs.downloadedAt,
    cancelRequested: ours.cancelRequested || theirs.cancelRequested,
  }
}

// ── Following ────────────────────────────────────────────────────────────────

const followers = new Map<string, AbortController>()

/** A job as last seen. A late answer saying it still runs never undoes one saying it ended. */
function seen(jobId: string, job: Job): void {
  const e = get(jobId)
  if (!e || (ended(e.job) && !ended(job))) return
  patch(jobId, { job, lost: null, endedAt: ended(job) ? (e.endedAt ?? Date.now()) : null })
}

function follow(jobId: string): void {
  const e = get(jobId)
  if (!e || exportEnded(e) || followers.has(jobId)) return
  const ctl = new AbortController()
  followers.set(jobId, ctl)
  void (async () => {
    try {
      const job = await pollJob(() => getExport(e.wsId, e.graphId, jobId), {
        signal: ctl.signal, onTick: (tick) => seen(jobId, tick),
      })
      seen(jobId, job)
      const now = get(jobId)
      if (now && job.status === 'completed' && job.kept !== false && !now.cancelRequested) await downloadOnce(jobId)
    } catch (err) {
      if (ctl.signal.aborted) return
      patch(jobId, { lost: err instanceof Error ? err.message : 'Lost touch with the export.' })
    } finally {
      if (followers.get(jobId) === ctl) followers.delete(jobId)
    }
  })()
}

function stopFollowing(jobId: string): void {
  followers.get(jobId)?.abort()
  followers.delete(jobId)
}

/** Start the file's download unless a tab already did, in a Web Lock where the browser has them:
 *  of two tabs that see it finish at once, one downloads it, and the other finds it marked. */
async function downloadOnce(jobId: string): Promise<void> {
  const start = () => {
    const e = get(jobId)
    if (!e) return
    const already = Number(remembered(downloadedKey(jobId)))
    if (already) {
      patch(jobId, { downloadedAt: already })
      return
    }
    downloadExportFile(jobId)
  }
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (locks) await locks.request(`background-export:${jobId}`, start)
  else start()
}

// ── What the app calls ───────────────────────────────────────────────────────

/** Keep an export just started, and follow it until its file downloads. One already kept (the
 *  answer to a request sent again) is followed as it is. */
export function trackExport(start: NewExport): BackgroundExport {
  const e = get(start.jobId) ?? {
    viewIds: undefined, format: undefined, total: null, exact: true, ...start,
    job: start.job ?? null, userId: currentUser(), startedAt: Date.now(), endedAt: null, downloadedAt: null,
  }
  put(e)
  follow(e.jobId)
  return e
}

/** Ask the server to stop export ``jobId``. Its job, as it answers, says where it ended: cancelled,
 *  or completed (or failed) just before. A file finished anyway is not downloaded by itself — the
 *  person asked not to have it. Throws when the server refuses, leaving the export as it was. */
export async function cancelBackgroundExport(jobId: string): Promise<Job> {
  const e = get(jobId)
  if (!e) throw new Error('This export is no longer followed here.')
  patch(jobId, { cancelRequested: true })
  try {
    const job = await cancelExport(e.wsId, e.graphId, jobId)
    seen(jobId, job)
    if (ended(job)) stopFollowing(jobId)
    return job
  } catch (err) {
    patch(jobId, { cancelRequested: false })
    // It may have finished while the cancel was asked for, its download held back for it.
    if (get(jobId) && exportStage(get(jobId)!) === 'ready') void downloadOnce(jobId)
    throw err
  }
}

/** Download a finished export's file now: again, or one finished after it was asked to stop. */
export function downloadExportFile(jobId: string): void {
  const e = get(jobId)
  if (!e) return
  const at = Date.now()
  remember(downloadedKey(jobId), String(at))
  triggerBrowserDownload(downloadExportUrl(e.wsId, e.graphId, jobId), e.fileName)
  patch(jobId, { downloadedAt: at })
}

/** Follow again an export this lost touch with. */
export function retryExport(jobId: string): void {
  patch(jobId, { lost: null })
  follow(jobId)
}

/** Let go of an export: no longer shown, followed, or kept. On the server it carries on. */
export function dismissExport(jobId: string): void {
  stopFollowing(jobId)
  drop(jobId)
  remember(KEY + jobId, null)
  remember(downloadedKey(jobId), null)
}

/** The newest export of the person signed in that ``match`` picks and that hasn't ended. */
export function findRunningExport(match: (e: BackgroundExport) => boolean): BackgroundExport | null {
  const user = currentUser()
  return useBackgroundExports.getState().exports
    .find((e) => e.userId === user && !exportEnded(e) && match(e)) ?? null
}

function onStorage(event: StorageEvent): void {
  if (!event.key?.startsWith(KEY)) return
  const jobId = event.key.slice(KEY.length)
  if (event.newValue == null) {                       // dismissed in another tab
    stopFollowing(jobId)
    drop(jobId)
    return
  }
  const theirs = parse(event.newValue)
  if (!theirs) return
  const ours = get(jobId)
  const e = ours ? merged(ours, theirs) : theirs
  put(e, false)
  if (exportEnded(e)) stopFollowing(jobId)          // the tab that saw it end downloads it
  else if (e.userId === currentUser()) follow(jobId)
}

/**
 * Follow, from this tab, every export of the person signed in that hasn't ended — those kept from
 * an earlier visit included — and hear of those other tabs start or let go of. Exports past the
 * day the server keeps their files are let go of. Returns the stop, which stops following them
 * here (they carry on on the server). The export tray runs it while someone is signed in.
 */
export function runBackgroundExports(): () => void {
  const user = currentUser()
  for (const e of stored()) {
    if (Date.now() - e.startedAt > KEPT_MS) dismissExport(e.jobId)
    else put(get(e.jobId) ? merged(get(e.jobId)!, e) : e, false)
  }
  for (const e of useBackgroundExports.getState().exports) {
    if (e.userId !== user || exportEnded(e)) continue
    if (e.lost) patch(e.jobId, { lost: null })        // a new visit tries again
    follow(e.jobId)
  }
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener('storage', onStorage)
    for (const jobId of [...followers.keys()]) stopFollowing(jobId)
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** The exports of the person signed in, newest first. */
export function useMyExports(): BackgroundExport[] {
  const user = useAuthStore((s) => s.user?.id ?? null)
  const exports = useBackgroundExports((s) => s.exports)
  return useMemo(() => exports.filter((e) => e.userId === user), [exports, user])
}

export function useBackgroundExport(jobId: string | null | undefined): BackgroundExport | null {
  return useBackgroundExports((s) => (jobId ? s.exports.find((e) => e.jobId === jobId) ?? null : null))
}

/** While a dialog shows export ``jobId``, the tray leaves it out. Once the dialog closes, an export
 *  it saw end is let go of (the person saw how it ended there); one still running goes to the tray. */
export function useShownExport(jobId: string | null | undefined): void {
  useEffect(() => {
    if (!jobId) return
    useBackgroundExports.setState((s) => ({ shown: [...s.shown, jobId] }))
    return () => {
      useBackgroundExports.setState((s) => {
        const i = s.shown.indexOf(jobId)
        return i < 0 ? s : { shown: [...s.shown.slice(0, i), ...s.shown.slice(i + 1)] }
      })
      const e = get(jobId)
      if (e && exportEnded(e) && exportStage(e) !== 'ready') dismissExport(jobId)
    }
  }, [jobId])
}
