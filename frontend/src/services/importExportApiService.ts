/**
 * Import/Export API Service — the bulk CRUD surface for a data source's graph.
 *
 * Backend-driven by design (so the same flow is scriptable/automatable): the browser uploads a
 * file to `POST /api/v1/{wsId}/versioning/graphs/{gid}/imports` (the file IS the request body,
 * options are query params), the server opens/append s a **draft**, resolves + applies the rows
 * onto it, and the changes become reviewable through the existing draft diff/publish endpoints.
 * Export is symmetric — an async job produces a downloadable, re-importable artifact (a backup).
 *
 * Talks to the workspace-scoped versioning router, mirroring `versioningApiService`
 * (cookie + CSRF session via `fetchWithTimeout`, camelCase wire types).
 */
import { authFetch } from './apiClient'

const base = (wsId: string) => `/api/v1/${wsId}/versioning`

export type ReconcileMode = 'upsert' | 'replace'
export type ImportFormat = 'ndjson' | 'csv' | 'tsv' | 'json'
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ImportSummary {
  new: number
  updated: number
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

export interface CreateExportResult {
  jobId: string
  resultUri: string
  status: JobStatus
}

export interface ImportPreviewRow {
  rowIndex: number
  kind: 'node' | 'edge'
  op?: string | null
  status?: string | null
  matchedEntityId?: string | null
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

/** Create an export job. A whole-data-source export doubles as a re-importable backup. */
export function createExport(
  wsId: string,
  graphId: string,
  opts: { format?: ImportFormat; asOfSeq?: number; viewId?: string; idempotencyKey?: string } = {},
): Promise<CreateExportResult> {
  const params = new URLSearchParams()
  params.set('format', opts.format ?? 'ndjson')
  if (opts.asOfSeq != null) params.set('asOfSeq', String(opts.asOfSeq))
  if (opts.viewId) params.set('viewId', opts.viewId)
  if (opts.idempotencyKey) params.set('idempotencyKey', opts.idempotencyKey)
  return authFetch<CreateExportResult>(
    `${base(wsId)}/graphs/${graphId}/exports?${params.toString()}`,
    { method: 'POST' },
  )
}

export function getExport(wsId: string, graphId: string, jobId: string): Promise<Job> {
  return authFetch<Job>(`${base(wsId)}/graphs/${graphId}/exports/${jobId}`)
}

/** Direct download URL for a completed export (browser sends the session cookie). */
export function downloadExportUrl(wsId: string, graphId: string, jobId: string): string {
  return `${base(wsId)}/graphs/${graphId}/exports/${jobId}/download`
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
