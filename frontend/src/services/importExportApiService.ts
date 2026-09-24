/**
 * Import/Export API Service — the bulk CRUD surface for a data source's graph.
 *
 * Backend-driven by design (so the same flow is scriptable/automatable): the browser uploads a
 * file to `POST /api/v1/{wsId}/versioning/graphs/{gid}/imports` (the file IS the request body,
 * options are query params), the server opens/append s a **draft**, resolves + applies the rows
 * onto it, and the changes become reviewable through the existing draft diff/publish endpoints.
 * Export is symmetric: ask what an export would hold (the plan), then the browser downloads it
 * as the server writes it, a re-importable artifact (a backup) of any size.
 *
 * Talks to the workspace-scoped versioning router, mirroring `versioningApiService`
 * (cookie + CSRF session via `fetchWithTimeout`, camelCase wire types).
 */
import { authFetch } from './apiClient'

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

/** Upload a file and start the import job (the file is the raw request body). */
export async function createImport(
  wsId: string,
  graphId: string,
  file: File | Blob,
  opts: CreateImportOptions = {},
): Promise<CreateImportResult> {
  const params = new URLSearchParams()
  params.set('format', opts.format ?? 'ndjson')
  params.set('reconcileMode', opts.reconcileMode ?? 'upsert')
  if (opts.branchId) params.set('branchId', opts.branchId)
  if (opts.viewId) params.set('viewId', opts.viewId)
  if (opts.idempotencyKey) params.set('idempotencyKey', opts.idempotencyKey)
  // Longer timeout: the upload streams the whole file in the request body.
  return authFetch<CreateImportResult>(
    `${base(wsId)}/graphs/${graphId}/imports?${params.toString()}`,
    { method: 'POST', body: file, timeoutMs: 120_000 } as RequestInit,
  )
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
