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
}

/** "2 jobs ahead of it" for a job waiting its turn on the server's workers; null when it isn't. */
export function queuePosition(job: Job | null | undefined): string | null {
  const ahead = job?.queuedAhead
  if (ahead == null) return null
  if (ahead === 0) return 'It starts next.'
  return `${ahead} ${ahead === 1 ? 'job is' : 'jobs are'} ahead of it.`
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

/** An import's file on its way up in parts. */
export interface ImportUpload {
  uploadId: string
  fileName: string
  size: number
  format: string
  partBytes: number
  parts: number
  /** The parts that arrived whole: what a resumed upload doesn't send again. */
  received: number[]
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
 *  but for a timeout or a busy server) is final. */
async function putPart(url: string, blob: Blob, signal?: AbortSignal): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null
    try {
      res = await fetchWithTimeout(url, { method: 'PUT', body: blob, signal, timeoutMs: 120_000 })
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

function remembered(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function remember(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* private mode: nothing is picked up again after a reload */ }
}

/**
 * Import ``file`` through a resumable upload: send it in parts (several at once, each retried),
 * then start the import from them. The same file (name, size and modification time) chosen again
 * after a failure or a reload resumes the upload where it stopped. ``onProgress`` hears the bytes
 * the server holds so far.
 */
export async function importInParts(
  wsId: string,
  graphId: string,
  file: File,
  opts: CreateImportOptions & { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<CreateImportResult> {
  const format = opts.format ?? 'ndjson'
  const key = `import-upload:${wsId}:${graphId}:${file.name}:${file.size}:${file.lastModified}:${format}`
  const earlier = remembered(key)
  let found = earlier ? await authFetch<ImportUpload>(`${uploadsUrl(wsId, graphId)}/${earlier}`).catch(() => null) : null
  if (found?.jobId) found = null                      // already imported: this is a new import
  const upload = found ?? await createImportUpload(wsId, graphId, file, format)
  remember(key, upload.uploadId)

  const bytesOf = (n: number) => Math.min(upload.size, (n + 1) * upload.partBytes) - n * upload.partBytes
  const arrived = new Set(upload.received)
  let sent = [...arrived].reduce((sum, n) => sum + bytesOf(n), 0)
  opts.onProgress?.(sent, upload.size)
  const todo = Array.from({ length: upload.parts }, (_, n) => n).filter((n) => !arrived.has(n))
  const partUrl = (n: number) => `${uploadsUrl(wsId, graphId)}/${upload.uploadId}/parts/${n}`
  const sender = async () => {
    for (let n = todo.shift(); n !== undefined; n = todo.shift()) {
      const start = n * upload.partBytes
      await putPart(partUrl(n), file.slice(start, start + bytesOf(n)), opts.signal)
      sent += bytesOf(n)
      opts.onProgress?.(sent, upload.size)
    }
  }
  await Promise.all(Array.from({ length: PART_CONCURRENCY }, sender))

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

/** Poll a job until it reaches a terminal state (or the signal aborts). */
export async function pollJob(
  fetcher: () => Promise<Job>,
  opts: { intervalMs?: number; onTick?: (job: Job) => void; signal?: AbortSignal } = {},
): Promise<Job> {
  const interval = opts.intervalMs ?? 800
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const job = await fetcher()
    opts.onTick?.(job)
    if (TERMINAL.includes(job.status)) return job
    await new Promise((r) => setTimeout(r, interval))
  }
}
