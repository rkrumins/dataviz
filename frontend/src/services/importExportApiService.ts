/**
 * Import/Export API Service — the bulk CRUD surface for a data source's graph.
 *
 * Backend-driven by design (so the same flow is scriptable/automatable): the browser uploads a
 * file in parts to `…/graphs/{gid}/imports/uploads` (resumable, up to 10 GB; a script can instead
 * send the whole file as the body of `POST …/imports`), the server opens/appends a **draft**,
 * resolves + applies the rows onto it, and the changes become reviewable through the existing
 * draft diff/publish endpoints.
 * Export is symmetric: ask what an export would hold (the plan), then download it, a
 * re-importable artifact (a backup). The server's workers prepare a data source with version
 * control's export (up to 50 GB), and its download resumes; one without streams as it is read.
 *
 * Talks to the workspace-scoped versioning router, mirroring `versioningApiService`
 * (cookie + CSRF session via `fetchWithTimeout`, camelCase wire types).
 */
import { authFetch } from './apiClient'
import { fetchWithTimeout } from './fetchWithTimeout'
import { httpStatusOf } from './graphRequestFailure'
import { jobPollDelayMs } from '@/config/polling'
import { extractErrorMessageFromText } from '@/lib/errorMessage'

const base = (wsId: string) => `/api/v1/${wsId}/versioning`

export type ReconcileMode = 'upsert' | 'replace'
export type ImportFormat = 'ndjson' | 'csv' | 'tsv' | 'json' | 'xlsx'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ImportSummary {
  new: number
  updated: number
  unchanged: number
  deleted: number
  invalid: number
  auto_fixed?: number
}

export interface ExportSummary {
  nodes: number
  edges: number
  bytes: number
  /** While it runs: the passes over the records so far (a spreadsheet reads them all once for its
   *  columns, then again to write them); `nodes` and `edges` count the current pass. */
  passes?: number
}

export interface Job {
  jobId: string
  jobType: 'ingest' | 'export'
  status: JobStatus
  graphId: string
  branchId?: string | null
  reconcileMode?: ReconcileMode | null
  importFormat?: string | null
  summary?: ImportSummary | ExportSummary | null
  errorMessage?: string | null
  createdAt?: string
  completedAt?: string | null
  /** Queued for the server's import/export workers: how many jobs are ahead of it; else absent. */
  queuedAhead?: number | null
  /** A finished export: whether its file is still kept to download (it is for a day). */
  kept?: boolean
  /** The step it is on: `queued` while it waits, then an import's `parse`, `nodes`, `edges` and
   *  (an import that replaces) `replace`; null between them. */
  phase?: string | null
  /** Percent done (an export says how far it has got in its `summary` instead). */
  progress?: number | null
  /** An import's rows applied so far, of all it has (while parsing, `total` is the rows read). */
  processed?: number | null
  total?: number | null
  /** Each time a server takes the job up is one attempt: past the first, it resumed where an
   *  earlier one stopped. */
  attempt?: number | null
  /** Running, but its server stopped answering: another one is about to take it over. */
  stale?: boolean
}

/** "2 jobs ahead of it" for a job waiting its turn on the server's workers; null when it isn't. */
export function queuePosition(job: Job | null | undefined): string | null {
  const ahead = job?.queuedAhead
  if (ahead == null) return null
  if (ahead === 0) return 'It starts next.'
  return `${ahead} ${ahead === 1 ? 'job is' : 'jobs are'} ahead of it.`
}

/** "Applying the changes… 4,000 of 10,000 rows" for a running import, and a view package's export
 *  by its steps (the records written so far come from its `summary`); null when there is nothing
 *  to tell (not running, between steps, or another export: it tells its progress in its `summary`). */
export function jobProgressText(job: Job | null | undefined): string | null {
  if (job?.status !== 'running') return null
  const processed = (job.processed ?? 0).toLocaleString()
  const total = job.total ?? 0
  switch (job.phase) {
    case 'parse': return `Reading the file… ${total.toLocaleString()} rows so far`
    case 'nodes':
    case 'edges': return total ? `Applying the changes… ${processed} of ${total.toLocaleString()} rows` : 'Applying the changes…'
    case 'replace': return 'Removing what the file no longer holds…'
    case 'bundle': return 'Packing the views…'
    case 'data': {
      const written = job.summary as ExportSummary | null
      return written?.nodes || written?.edges
        ? `Writing the data… ${written.nodes.toLocaleString()} entities and ${written.edges.toLocaleString()} relationships so far`
        : 'Writing the data…'
    }
    default: return null
  }
}

/** Why a job takes longer than it might: its server stopped answering (it is `stale` until another
 *  takes it over), or one did and the job resumed where it left off (`attempt` past the first).
 *  Null for a job on its first run, and for one that ended. */
export function resumeNote(job: Job | null | undefined): string | null {
  if (!job || TERMINAL.includes(job.status)) return null
  if (job.stale) return 'The server running it stopped answering. Another one carries on from where it got to.'
  const attempt = job.attempt ?? 0
  // A queued job has not been taken up again yet: any attempt was an earlier run.
  if (job.status === 'pending') return attempt >= 1 ? 'It resumes where it left off.' : null
  return attempt > 1 ? `Resumed where it left off (attempt ${attempt}).` : null
}

export interface CreateImportResult {
  jobId: string
  branchId: string
  sourceUri: string
  status: JobStatus
}

export interface ImportPreviewRow {
  rowIndex: number
  kind: 'node' | 'edge'
  op?: string | null
  status?: string | null
  matchedEntityId?: string | null
  label?: string
  reasons?: string[]
}

export interface ImportPreview {
  job: Job
  summary?: ImportSummary | null
  sample: ImportPreviewRow[]
  previewDownloadUrl?: string | null
  rejectedDownloadUrl?: string | null
}

export interface CreateImportOptions {
  format?: ImportFormat
  reconcileMode?: ReconcileMode
  /** Stack onto an existing working draft (repeat imports, like successive manual edits). */
  branchId?: string
  viewId?: string
  idempotencyKey?: string
}

const TERMINAL: JobStatus[] = ['completed', 'failed', 'cancelled']

/** Infer the import format from a file name; defaults to ndjson. */
export function inferFormat(fileName: string): ImportFormat {
  const ext = fileName.toLowerCase().split('.').pop() || ''
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx'
  if (ext === 'csv') return 'csv'
  if (ext === 'tsv') return 'tsv'
  if (ext === 'json') return 'json'
  return 'ndjson'
}

// ── Resumable upload ─────────────────────────────────────────────────────────
// A large file goes up in parts, each its own request, several at once; a part that fails is sent
// again, and an upload interrupted by a dropped connection or a reload resumes where it stopped.

/** The most one import can be: a file read a row at a time (NDJSON, CSV, TSV) up to 10 GiB, a JSON
 *  array or Excel workbook (read whole) up to 100 MB. The server holds the same limits. */
export const MAX_IMPORT_BYTES = 10 * 1024 ** 3
export const MAX_WHOLE_FILE_IMPORT_BYTES = 100 * 1024 ** 2

export function importLimit(format: ImportFormat): number {
  return format === 'json' || format === 'xlsx' ? MAX_WHOLE_FILE_IMPORT_BYTES : MAX_IMPORT_BYTES
}

/** A file on its way up in parts, as the server describes it: how it is split, and what it has. */
export interface PartsUpload {
  uploadId: string
  size: number
  partBytes: number
  parts: number
  /** The parts that arrived whole: what a resumed upload doesn't send again. */
  received: number[]
  /** Where each part goes straight to the server's object store, when it hands such URLs out;
   *  otherwise every part goes through the server. */
  partUrls?: string[]
}

/** An import's file on its way up in parts. */
export interface ImportUpload extends PartsUpload {
  fileName: string
  format: string
  jobId?: string | null
}

const PART_CONCURRENCY = 3
const PART_ATTEMPTS = 5

const uploadsUrl = (wsId: string, graphId: string) => `${base(wsId)}/graphs/${graphId}/imports/uploads`

function createImportUpload(wsId: string, graphId: string, file: File, format: ImportFormat): Promise<ImportUpload> {
  return authFetch<ImportUpload>(uploadsUrl(wsId, graphId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, size: file.size, format }),
  })
}

/** Send one part, retrying a dropped connection or a server error with backoff; a refusal (4xx,
 *  but for a timeout or a busy server) is final. `direct`: the URL is the object store's own,
 *  which must not be sent this site's session cookies. */
async function putPart(url: string, blob: Blob, signal?: AbortSignal, direct = false): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetchWithTimeout(url, {
        method: 'PUT', body: blob, signal, timeoutMs: 120_000, ...(direct ? { credentials: 'omit' as const } : {}),
      })
    } catch (err) {
      if (signal?.aborted || attempt >= PART_ATTEMPTS) throw err
    }
    if (res?.ok) return
    if (res && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new Error(extractErrorMessageFromText(await res.text(), res.statusText))
    }
    if (attempt >= PART_ATTEMPTS) throw new Error("Part of the file couldn't be sent. Try again: it resumes where it stopped.")
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
  }
}

/** A value this browser keeps for a later visit (localStorage); null when there is none, or no
 *  storage to keep it in. */
export function remembered(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** Keep `value` under `key` for a later visit; null forgets it. */
export function remember(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* private mode: nothing is picked up again after a reload */ }
}

/**
 * Send ``file`` up in parts, several at once, each retried, resuming an upload of it where it
 * stopped. ``key`` names the file as this browser remembers its upload (by name, size and
 * modification time, so the same file chosen again after a failure or a reload is found again);
 * ``find`` reads the remembered upload as the server holds it now (null, or a refusal, when it
 * can't be resumed: ``create`` starts another). ``partUrl`` says where part n goes through the
 * server, unless the upload names its own ``partUrls``. ``onProgress`` hears the bytes the server
 * holds so far. Returns the upload with every part sent; it stays remembered until the caller
 * forgets it (``remember(key, null)``), once done with it.
 */
export async function sendInParts<U extends PartsUpload>(file: File, opts: {
  key: string
  find: (uploadId: string) => Promise<U | null>
  create: () => Promise<U>
  partUrl: (uploadId: string, n: number) => string
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
}): Promise<U> {
  const earlier = remembered(opts.key)
  const found = earlier ? await opts.find(earlier).catch(() => null) : null
  const upload = found ?? await opts.create()
  remember(opts.key, upload.uploadId)

  const bytesOf = (n: number) => Math.min(upload.size, (n + 1) * upload.partBytes) - n * upload.partBytes
  const arrived = new Set(upload.received)
  let sent = [...arrived].reduce((sum, n) => sum + bytesOf(n), 0)
  opts.onProgress?.(sent, upload.size)
  const todo = Array.from({ length: upload.parts }, (_, n) => n).filter((n) => !arrived.has(n))
  const direct = !!upload.partUrls?.length
  const sender = async () => {
    for (let n = todo.shift(); n !== undefined; n = todo.shift()) {
      const start = n * upload.partBytes
      const url = direct ? upload.partUrls![n] : opts.partUrl(upload.uploadId, n)
      await putPart(url, file.slice(start, start + bytesOf(n)), opts.signal, direct)
      sent += bytesOf(n)
      opts.onProgress?.(sent, upload.size)
    }
  }
  await Promise.all(Array.from({ length: PART_CONCURRENCY }, sender))
  return upload
}

/**
 * Import ``file`` through a resumable upload (``sendInParts``), then start the import from its
 * parts. The same file chosen again after a failure or a reload resumes the upload where it
 * stopped. ``onProgress`` hears the bytes the server holds so far.
 */
export async function importInParts(
  wsId: string,
  graphId: string,
  file: File,
  opts: CreateImportOptions & { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<CreateImportResult> {
  const format = opts.format ?? 'ndjson'
  const key = `import-upload:${wsId}:${graphId}:${file.name}:${file.size}:${file.lastModified}:${format}`
  const upload = await sendInParts(file, {
    key,
    // One already imported is done with: this is a new import.
    find: async (id) => {
      const found = await authFetch<ImportUpload>(`${uploadsUrl(wsId, graphId)}/${id}`)
      return found.jobId ? null : found
    },
    create: () => createImportUpload(wsId, graphId, file, format),
    partUrl: (id, n) => `${uploadsUrl(wsId, graphId)}/${id}/parts/${n}`,
    onProgress: opts.onProgress,
    signal: opts.signal,
  })

  const params = new URLSearchParams({ reconcileMode: opts.reconcileMode ?? 'upsert' })
  if (opts.branchId) params.set('branchId', opts.branchId)
  if (opts.viewId) params.set('viewId', opts.viewId)
  const created = await authFetch<CreateImportResult>(
    `${uploadsUrl(wsId, graphId)}/${upload.uploadId}/complete?${params.toString()}`, { method: 'POST' })
  remember(key, null)
  return created
}

export function getImport(wsId: string, graphId: string, jobId: string): Promise<Job> {
  return authFetch<Job>(`${base(wsId)}/graphs/${graphId}/imports/${jobId}`)
}

export function getImportPreview(wsId: string, graphId: string, jobId: string): Promise<ImportPreview> {
  return authFetch<ImportPreview>(`${base(wsId)}/graphs/${graphId}/imports/${jobId}/preview`)
}

export function listImports(wsId: string, graphId: string): Promise<Job[]> {
  return authFetch<Job[]>(`${base(wsId)}/graphs/${graphId}/imports`)
}

export function getExport(wsId: string, graphId: string, jobId: string): Promise<Job> {
  return authFetch<Job>(`${base(wsId)}/graphs/${graphId}/exports/${jobId}`)
}

/** Direct download URL for a completed export (browser sends the session cookie). */
export function downloadExportUrl(wsId: string, graphId: string, jobId: string): string {
  return `${base(wsId)}/graphs/${graphId}/exports/${jobId}/download`
}

/** URL for a prepopulated starter template (columns + a few real/example rows). */
export function templateDownloadUrl(wsId: string, graphId: string, format: ImportFormat = 'csv'): string {
  return `${base(wsId)}/graphs/${graphId}/imports/template?format=${format}`
}

/** Trigger a browser download with an explicit filename (so the extension is always correct —
 *  the browser otherwise falls back to the URL segment, which has no extension). */
export function triggerBrowserDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Detect a file's import format. An unambiguous extension wins; otherwise (none after a download,
 *  or an unknown one) the CONTENT decides: a "PK" zip signature is a workbook, and the first
 *  non-whitespace character tells a JSON array (`[`) from json-lines (`{`) — never a JSON.parse of
 *  the first line, which a single-line array longer than the read truncates. Else tsv when the
 *  first line has a tab and no comma, otherwise csv. */
export async function detectFormat(file: File): Promise<ImportFormat> {
  const ext = file.name.toLowerCase().split('.').pop() || ''
  if (ext === 'json') return 'json'
  if (ext === 'ndjson' || ext === 'jsonl') return 'ndjson'
  if (ext === 'csv') return 'csv'
  if (ext === 'tsv' || ext === 'tab') return 'tsv'
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx'
  try {
    const sig = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    if (sig[0] === 0x50 && sig[1] === 0x4b) return 'xlsx'   // "PK" → an Excel workbook
    const head = (await file.slice(0, 8192).text()).replace(/^\uFEFF/, '')
    const first = head.trimStart()[0]
    if (first === '[') return 'json'
    if (first === '{') return 'ndjson'
    const firstLine = (head.split(/\r?\n/).find((l) => l.trim().length > 0) || '').trim()
    return firstLine.includes('\t') && !firstLine.includes(',') ? 'tsv' : 'csv'
  } catch { /* unreadable — fall back to the name */ }
  return inferFormat(file.name)
}

/** What an export would hold, asked before downloading it (`/exports/plan`, `/graph/export/plan`). */
export interface ExportPlan {
  format: ImportFormat
  /** `null` when too many to count quickly. */
  nodes: number | null
  edges: number | null
  /** Counted exactly; otherwise an estimate (or unknown). */
  exact: boolean
  /** `true` when there is nothing to export; `null` when that isn't known yet. */
  empty: boolean | null
  /** Why this format can't hold the export (an Excel sheet stops at 1,048,575 rows), if it can't. */
  formatLimit: string | null
  /** A view-scoped export: how many entities the view places, how many were found, how many it
   *  holds with their contents. `placements: 0` means the view places none, so the whole data
   *  source is exported. */
  view?: { viewId: string; placements: number; found: number; entities: number | null } | null
}

/** Which data an export reads. A version-controlled data source exports from its versioned graph
 *  (`graphId`): published, a draft (`branchId`), or one view's entities (`viewId`). One without
 *  version control (`graphId` null) exports its whole live graph, a cold copy. */
export interface ExportTarget {
  wsId: string
  dataSourceId: string
  graphId: string | null
  viewId?: string
  branchId?: string
}

function exportQuery(target: ExportTarget, format: ImportFormat, extra: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams({ format })
  if (!target.graphId) q.set('dataSourceId', target.dataSourceId)
  if (target.graphId && target.viewId) q.set('viewId', target.viewId)
  if (target.graphId && target.branchId) q.set('branchId', target.branchId)
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v)
  return q.toString()
}

function exportBase(target: ExportTarget): string {
  return target.graphId
    ? `${base(target.wsId)}/graphs/${target.graphId}/exports`
    : `/api/v1/${target.wsId}/graph/export`
}

export function planExport(target: ExportTarget, format: ImportFormat): Promise<ExportPlan> {
  return authFetch<ExportPlan>(`${exportBase(target)}/plan?${exportQuery(target, format)}`)
}

export interface CreateExportResult {
  jobId: string
  resultUri: string
  status: JobStatus
}

/** Have the server prepare an export of a data source with version control: its workers write
 *  the file, then `downloadExportUrl` downloads it, a download the browser can resume. Follow it
 *  with `getExport`. */
export function createExport(
  target: ExportTarget, format: ImportFormat, opts: { props?: string[]; filename?: string } = {},
): Promise<CreateExportResult> {
  return authFetch<CreateExportResult>(`${exportBase(target)}?${exportQuery(target, format, {
    props: opts.props?.length ? opts.props.join(',') : undefined,
    filename: opts.filename,
  })}`, { method: 'POST' })
}

/** An export the server is preparing, remembered in this browser until its download starts, so
 *  the dialog finds it again after being closed. */
export interface PreparedExport {
  jobId: string
  fileName: string
  format: ImportFormat
  /** The records the plan counted (nodes and edges), for the progress; null when unknown. */
  total: number | null
  exact: boolean
}

const preparedKey = (wsId: string, graphId: string) => `graph-export:${wsId}:${graphId}`

export function preparedExport(wsId: string, graphId: string): PreparedExport | null {
  try { return JSON.parse(remembered(preparedKey(wsId, graphId)) ?? 'null') } catch { return null }
}

export function rememberExport(wsId: string, graphId: string, prepared: PreparedExport | null): void {
  remember(preparedKey(wsId, graphId), prepared && JSON.stringify(prepared))
}

/** The streamed download itself: a plain GET the browser saves as it arrives (the session cookie
 *  authenticates it), so a file of any size never passes through this page's memory. */
export function exportStreamUrl(
  target: ExportTarget, format: ImportFormat, opts: { props?: string[]; filename?: string } = {},
): string {
  return `${exportBase(target)}/stream?${exportQuery(target, format, {
    props: opts.props?.length ? opts.props.join(',') : undefined,
    filename: opts.filename,
  })}`
}

/** A failed poll worth asking again: all but a refusal. A dropped connection, a client timeout and
 *  a web pod restarting (502/503) are asked again, as is an error that carries no status at all.
 *  Final at once: a session that ended (the fetch layer already tried to renew it) and a refusal
 *  whose status the error carries (`authFetch`'s and the services' own errors do): a 4xx, but for
 *  a timeout or a busy server. */
function isTransientPollError(err: unknown): boolean {
  if (err instanceof Error && err.message === 'Session expired') return false
  const status = httpStatusOf(err)
  return status == null || status >= 500 || status === 408 || status === 429
}

/** Resolves once the hidden tab is shown, or the signal aborts. */
function whileHidden(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (document.hidden && !signal?.aborted) return
      document.removeEventListener('visibilitychange', check)
      signal?.removeEventListener('abort', check)
      resolve()
    }
    document.addEventListener('visibilitychange', check)
    signal?.addEventListener('abort', check)
  })
}

/** Resolves after `ms`, or as soon as the signal aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done)
  })
}

/**
 * Poll a job until it ends (or the signal aborts, which rejects with an `AbortError`), every
 * `jobPollDelayMs`: often while it may still be a short job, then less. Read-only and cheap for
 * the server, but every open dialog does it, so it also stops asking while the tab is hidden and
 * asks at once when it is shown again.
 *
 * A failed poll doesn't stop the job, which runs on the server's workers whatever this sees: a
 * transient failure (see `isTransientPollError`) is asked again until the job has gone unanswered
 * for `patienceMs` (counted while the tab is shown), and only then is it this poll's error.
 *
 * `until` says when what is followed is done, for one that isn't a job (a package upload being
 * checked); a job is done once it ended.
 */
export async function pollJob<J extends { status: string }>(
  fetcher: () => Promise<J>,
  opts: {
    onTick?: (job: J) => void
    signal?: AbortSignal
    patienceMs?: number
    until?: (job: J) => boolean
  } = {},
): Promise<J> {
  const { signal, patienceMs = 120_000, until = (job: J) => TERMINAL.includes(job.status as JobStatus) } = opts
  const aborted = () => new DOMException('aborted', 'AbortError')
  let answeredAt = Date.now()
  for (let tick = 0; ; tick++) {
    if (typeof document !== 'undefined' && document.hidden) {
      await whileHidden(signal)
      answeredAt = Date.now()          // a hidden tab wasn't asking: its silence isn't the job's
    }
    if (signal?.aborted) throw aborted()
    let job: J | null = null
    try {
      job = await fetcher()
      answeredAt = Date.now()
    } catch (err) {
      if (signal?.aborted) throw aborted()
      if (!isTransientPollError(err) || Date.now() - answeredAt >= patienceMs) throw err
    }
    if (signal?.aborted) throw aborted()
    if (job) {
      opts.onTick?.(job)
      if (until(job)) return job
    }
    await pause(jobPollDelayMs(tick), signal)
  }
}
