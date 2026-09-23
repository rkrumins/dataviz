/**
 * Moving views between environments: export a view to a file, and import one.
 *
 * A file (`*.view.json`, a "View Bundle") holds 1..N views, each with its design, a content hash
 * that proves the design is exactly what was exported, the names and types of the entities it
 * places, and the hashes of its whole version history. The server does all hashing, parsing and
 * checking; this module only moves requests and gives errors a shape the UI can branch on.
 *
 * API scope: /api/v1/views/transfer
 */
import { TIMEOUTS } from '@/config/timeouts'
import { useHealthStore } from '@/store/health'
import { fetchWithTimeout } from './fetchWithTimeout'
import {
  downloadExportUrl, getExport, pollJob, triggerBrowserDownload, type Job,
} from './importExportApiService'
import type { View } from './viewApiService'
import type { ViewDefinitionDiff, ViewVersionSummary } from './viewVersionsApiService'

const BASE = '/api/v1/views/transfer'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ImportAction = 'create' | 'copy' | 'update' | 'overwrite'
export type UpdateStrategy = 'replace' | 'merge'
export type BundleIntegrity = 'verified' | 'modified' | 'unverifiable'
export type UpdateStatus = 'up_to_date' | 'file_is_older' | 'fast_forward' | 'diverged' | 'unrelated'
export type EntityStatus = 'matched' | 'renamed' | 'type_changed' | 'missing' | 'unknown'
export type ReconcileVerdict = 'ready' | 'attention' | 'blocked'

export interface BundleEntityInfo {
  name?: string | null
  type?: string | null
  qualifiedName?: string | null
}

export interface BundleManifest {
  counts: Record<string, number>
  entities: Record<string, BundleEntityInfo>
  /** False when the exporting environment couldn't name its entities. */
  entitiesResolved: boolean
}

export interface BundleHistoryEntry {
  environment?: string | null
  viewId?: string | null
  version?: number | null
  hash: string
  source?: string | null
  createdAt?: string | null
  createdBy?: string | null
  message?: string | null
}

export interface BundleViewMetadata {
  name: string
  description?: string | null
  icon?: string | null
  tags: string[]
  viewType: string
}

export interface BundleSource {
  workspace: { id?: string | null; name?: string | null }
  dataSource: {
    id?: string | null
    label?: string | null
    providerType?: string | null
    graphName?: string | null
    catalogSourceIdentifier?: string | null
    identityProperty?: string | null
  }
  ontology: { name?: string | null; version?: number | null; digest?: string | null }
}

export interface BundleHeader {
  format: string
  formatVersion: number
  exportedAt?: string | null
  exportedBy: { displayName?: string | null }
  generator: { product?: string | null; environment?: string | null }
  sources: Record<string, BundleSource>
  bundleHash?: string | null
}

/** A view in an inspected file, with its definition already in canonical form. */
export interface InspectedView {
  index: number
  source: string
  portableId: string
  sourceViewId?: string | null
  version?: number | null
  definitionHash: string
  actualHash: string
  integrity: Exclude<BundleIntegrity, 'unverifiable'>
  metadata: BundleViewMetadata
  definition: Record<string, unknown>
  manifest: BundleManifest
  history: BundleHistoryEntry[]
  historyTruncated: boolean
}

/** A view here that IS a view in the file (same identity), and how the two stand. */
export interface IdentityMatch {
  viewId: string
  name: string
  workspaceId: string
  workspaceName?: string | null
  dataSourceId?: string | null
  dataSourceName?: string | null
  headVersion?: number | null
  canEdit: boolean
  status: UpdateStatus
  baseVersion?: number | null
}

/** A data source here the file's source most likely is, measured on a sample of entities. */
export interface TargetSuggestion {
  workspaceId: string
  workspaceName?: string | null
  dataSourceId: string
  label?: string | null
  providerType?: string | null
  graphName?: string | null
  score: number
  reasons: string[]
  sampleSize: number
  /** Share of the sample found in this data source; null when it couldn't be probed. */
  sampleHitRate: number | null
  /** Packages only: whether the data source is under version control (so can take the data). */
  versioned?: boolean
}

export interface InspectResult {
  bundle: BundleHeader
  integrity: BundleIntegrity
  notices: Array<{ code: string; message: string; view?: string }>
  views: InspectedView[]
  /** Keyed by portableId. */
  identityMatches: Record<string, IdentityMatch[]>
  /** Keyed by the file's source key (`views[].source`). */
  targetSuggestions: Record<string, TargetSuggestion[]>
}

/** The importer's answers to what didn't match, applied before anything is checked or written. */
export interface Resolutions {
  remap?: Record<string, string>
  drop?: string[]
  typeMap?: Record<string, string>
  dropTypes?: string[]
  relTypeMap?: Record<string, string>
  dropRelTypes?: string[]
}

export interface TransferTarget {
  workspaceId?: string | null
  dataSourceId?: string | null
  viewId?: string | null
  /** One of the caller's drafts of that data source: checked against as the draft reads (a
   *  package's data counts as there), and, when staging, the draft the view goes into. */
  branchId?: string | null
}

export interface ReconcileCounts {
  total: number
  matched: number
  renamed: number
  typeChanged: number
  missing: number
  unknown: number
  found: number
  checked: number
  matchRate: number | null
}

export interface ReconcileException {
  urn: string
  status: Exclude<EntityStatus, 'matched'>
  kinds: string[]
  layerId: string | null
  exported: BundleEntityInfo | null
  target: BundleEntityInfo | null
}

export interface ReconcileTypeRow {
  id: string
  status: 'present' | 'missing' | 'unknown'
  suggestions: string[]
  layers: string[]
}

export interface ReconcileLayerRow extends Omit<ReconcileCounts, 'matchRate'> {
  id: string
  name?: string | null
  color?: string | null
  anchor: { urn: string; status: EntityStatus } | null
  healthy: boolean
}

export interface ReconcileNotice {
  code: string
  severity: 'error' | 'warning' | 'info'
  message: string
  count?: number
}

export interface ReconcileSummary {
  entities: ReconcileCounts
  byKind: Record<string, ReconcileCounts>
  entityTypes: { total: number; missing: number }
  relationshipTypes: { total: number; missing: number }
  layers: { total: number; healthy: number }
  displayRules: number
  urnPatterns: number
  matchRate: number | null
  coverage: number
  verdict: ReconcileVerdict
  verdictReason: string
}

export interface ReconcileReport {
  summary: ReconcileSummary
  entities: ReconcileException[]
  entitiesTruncated: boolean
  types: { entity: ReconcileTypeRow[]; relationship: ReconcileTypeRow[] }
  layers: ReconcileLayerRow[]
  notices: ReconcileNotice[]
}

export interface UpdatePreview {
  status: UpdateStatus
  base: { version: number; hash: string } | null
  targetHead: { version: number; hash: string } | null
  targetWorkingHash: string
  mergeAvailable: boolean
  strategy: UpdateStrategy
  conflicts: string[]
  diff: ViewDefinitionDiff
}

export interface ReconciledView {
  key: string
  effectiveDefinition: Record<string, unknown>
  effectiveHash: string
  report: ReconcileReport
  update: UpdatePreview | null
}

export interface ReconcileResult {
  views: ReconciledView[]
  aggregate: { entities: ReconcileCounts; verdicts: Partial<Record<ReconcileVerdict, number>>; views: number }
}

export interface ReconcileViewRequest {
  key: string
  portableId?: string | null
  definition: Record<string, unknown>
  viewType: string
  manifest?: BundleManifest
  /** The file's version hashes (`history[].hash`). */
  history?: string[]
  target: TransferTarget
  action: ImportAction
  strategy?: UpdateStrategy
  resolutions?: Resolutions
}

export interface ImportOrigin {
  portableId?: string | null
  sourceViewId?: string | null
  version?: number | null
  definitionHash?: string | null
  name?: string | null
  environment?: string | null
  exportedAt?: string | null
  exportedBy?: string | null
  fileName?: string | null
}

export interface ImportViewRequest {
  action: ImportAction
  strategy?: UpdateStrategy
  target: TransferTarget
  metadata: BundleViewMetadata & { visibility?: 'private' | 'workspace' | 'enterprise' }
  /** The definition to write: `effectiveDefinition` from reconcile, plus any edits since. */
  definition: Record<string, unknown>
  origin: ImportOrigin
  /** The file's own definition, when `definition` differs from it (choices made on the way in, a
   *  merge, edits in the wizard): kept with the version so later files still find it. */
  originDefinition?: Record<string, unknown>
  manifest?: BundleManifest
  history?: BundleHistoryEntry[]
  resolutions?: Resolutions
  /** The target's design hash when it was reviewed: refused (409) if it has moved since. */
  expectedTargetHash?: string | null
  requestId?: string
  batchId?: string | null
  /** Import into a draft of the (version-controlled) data source instead of live: the view
   *  changes, or appears, when the draft is published or its review merges. */
  stage?: boolean
}

export interface ImportIntegrity {
  submittedHash: string
  storedHash: string
  /** What was stored is exactly what was sent. */
  verified: boolean
  /** This environment's rules changed it on the way in (see `adjustments`). */
  adjusted: boolean
  adjustments: string[]
  /** This answer is the first attempt's: the request was a retry. */
  replayed?: boolean
}

export interface ImportViewResult {
  /** As it now reads: on its draft, when the import was staged. */
  view: View
  viewId: string
  /** The version written; none for an update staged in a draft (it's written when the draft
   *  goes live). */
  version: ViewVersionSummary | null
  /** The full report, or on a replayed retry, its summary and layers. */
  report: Partial<ReconcileReport> & Pick<ReconcileReport, 'summary'>
  notices: string[]
  integrity: ImportIntegrity
  /** Set when the import waits in a draft: the draft it's in. */
  staged?: { branchId: string } | null
}

/** What exporting a view as it stands would write (`POST /export/preview`); nothing is written. */
export interface ExportPreview {
  viewId: string
  name: string
  workspaceId: string
  dataSourceId: string | null
  headVersion: number | null
  /** The design has changed since `headVersion`. */
  dirty: boolean
  /** The caller may edit the view, so its export saves unsaved changes as a new version first.
   *  Anyone else exports the latest version as it stands. */
  maySeal: boolean
  /** The version the file names. */
  exportsAs: number
  includesUnsaved: boolean
  stats: Record<string, number>
  estimatedBytes: number
}

export function previewExport(viewIds: string[]): Promise<{ views: ExportPreview[] }> {
  return postJson('/export/preview', { viewIds })
}

export interface ExportedFile {
  filename: string
  bytes: number
  bundleHash: string | null
  /** Single-view exports: the design's hash and the version it was exported as. */
  definitionHash: string | null
  version: number | null
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** A refusal with the server's machine-readable reason, so the UI can say what to do next
 *  (e.g. `type: 'target_changed'` → check again; `code: 'package'` → the other journey). */
export class ViewTransferError extends Error {
  readonly status: number
  readonly type?: string
  readonly code?: string

  constructor(message: string, status: number, type?: string, code?: string) {
    super(message)
    this.name = 'ViewTransferError'
    this.status = status
    this.type = type
    this.code = code
  }
}

async function errorFrom(res: Response): Promise<ViewTransferError> {
  const text = await res.text()
  let detail: unknown = null
  try {
    detail = (JSON.parse(text) as { detail?: unknown }).detail
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return new ViewTransferError('Session expired', 401)
  if (typeof detail === 'string') return new ViewTransferError(detail, res.status)
  if (Array.isArray(detail)) {
    const first = detail.find((d) => d && typeof d === 'object' && typeof d.msg === 'string')
    return new ViewTransferError(first?.msg ?? 'The request was not valid.', res.status)
  }
  if (detail && typeof detail === 'object') {
    const d = detail as { message?: string; type?: string; code?: string }
    return new ViewTransferError(d.message || res.statusText, res.status, d.type, d.code)
  }
  return new ViewTransferError(text || res.statusText, res.status)
}

async function send(path: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetchWithTimeout(`${BASE}${path}`, { ...init, timeoutMs: TIMEOUTS.VIEW_TRANSFER_MS })
  } catch (err) {
    useHealthStore.getState().reportFailure(err)
    throw err
  }
  if (!res.ok) throw await errorFrom(res)
  return res
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await send(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<T>
}

// ── Export ────────────────────────────────────────────────────────────────────

/** `attachment; filename="finance.v7.view.json"` → `finance.v7.view.json`. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header)
  return match ? decodeURIComponent(match[1].trim()) : null
}

/**
 * Export views to a file and start the download. Each view exports as a real version: the one
 * asked for, or its current design (saved as a new version first when it has unsaved changes).
 */
export async function exportViews(
  views: Array<{ viewId: string; version?: number | null }>,
  message?: string,
): Promise<ExportedFile> {
  const res = await send('/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      views: views.map((v) => (v.version ? { viewId: v.viewId, version: v.version } : { viewId: v.viewId })),
      message: message || null,
    }),
  })
  const blob = await res.blob()
  const filename = filenameFromDisposition(res.headers.get('Content-Disposition'))
    ?? (views.length === 1 ? 'view.view.json' : `${views.length}-views.view.json`)
  const url = URL.createObjectURL(blob)
  triggerBrowserDownload(url, filename)
  // Some browsers read the object URL after click() returns; release it once they're done.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  const version = Number(res.headers.get('X-View-Version'))
  return {
    filename,
    bytes: blob.size,
    bundleHash: res.headers.get('X-Bundle-Hash'),
    definitionHash: res.headers.get('X-Definition-Hash'),
    version: Number.isFinite(version) && version > 0 ? version : null,
  }
}

// ── Import ────────────────────────────────────────────────────────────────────

/** Read a view file without writing anything: integrity, the views here it already is, and
 *  where it most likely belongs. The file goes up as-is; the server parses it. */
export async function inspectViewFile(file: Blob): Promise<InspectResult> {
  const res = await send('/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: file,
  })
  return res.json() as Promise<InspectResult>
}

/** What each view would be, and how well it matches, where it's going. Writes nothing. */
export function reconcileViews(views: ReconcileViewRequest[]): Promise<ReconcileResult> {
  return postJson<ReconcileResult>('/reconcile', { views })
}

/** Write one view from a file. Safe to retry with the same `requestId`. */
export function importView(request: ImportViewRequest): Promise<ImportViewResult> {
  return postJson<ImportViewResult>('/import', request)
}

/** A request id for `importView`: one per attempt the person makes, reused on retries. */
export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

// ── A view with its data: the View Package ────────────────────────────────────

export type PackageScope = 'view' | 'source'
export type PackageDataVersion = 'published' | 'draft'

export interface PackageStarted {
  jobId: string
  graphId: string
  workspaceId: string
  fileName: string
  bundleHash: string
  views: Array<{ viewId: string; version: number }>
}

export interface ExportedPackage extends PackageStarted {
  bytes: number | null
  nodes: number | null
  edges: number | null
}

/**
 * Package views with their graph data and download it. An export job builds the package on the
 * server (the data can be large); this starts it, follows it, and downloads the result.
 */
export async function exportViewPackage(
  views: Array<{ viewId: string; version?: number | null }>,
  options: { scope: PackageScope; dataVersion: PackageDataVersion; message?: string },
  onJob?: (job: Job) => void,
  signal?: AbortSignal,
): Promise<ExportedPackage> {
  const started = await postJson<PackageStarted>('/packages', {
    views: views.map((v) => (v.version ? { viewId: v.viewId, version: v.version } : { viewId: v.viewId })),
    scope: options.scope,
    dataVersion: options.dataVersion,
    message: options.message || null,
  })
  const job = await pollJob(() => getExport(started.workspaceId, started.graphId, started.jobId), {
    intervalMs: 1000, onTick: onJob, signal,
  })
  if (job.status !== 'completed') {
    throw new ViewTransferError(job.errorMessage || 'The package could not be built.', 500)
  }
  triggerBrowserDownload(downloadExportUrl(started.workspaceId, started.graphId, started.jobId), started.fileName)
  const summary = (job.summary ?? {}) as { nodes?: number; edges?: number; package?: { bytes?: number } }
  return {
    ...started,
    bytes: summary.package?.bytes ?? null,
    nodes: summary.nodes ?? null,
    edges: summary.edges ?? null,
  }
}

export interface PackagePart {
  sha256: string
  bytes: number
  verified: boolean
  views?: number
  bundleHash?: string
}

export interface PackageInspectResult extends InspectResult {
  /** Keeps the package's data on the server (for a day) until it is imported. */
  uploadId: string
  package: {
    scope: PackageScope | null
    data: { version?: PackageDataVersion; nodes?: number | null; edges?: number | null } | null
    createdAt?: string | null
    parts: Record<string, PackagePart>
    integrity: 'verified' | 'modified'
  }
}

/** Read a view package: every part checked, the data kept for the import that follows, and the
 *  views described as for a view file. */
export async function inspectViewPackage(file: Blob): Promise<PackageInspectResult> {
  const res = await send('/packages/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  })
  return res.json() as Promise<PackageInspectResult>
}

export interface PackageDataStarted {
  jobId: string
  branchId: string
  graphId: string
  workspaceId: string
  dataSourceId: string
  /** The view the draft was opened for (an update), if any. */
  viewId?: string | null
  draftName: string
}

/** Bring an inspected package's data into a new draft of the target data source. The view then
 *  follows into the same draft. Asking again for the same target answers with the job already
 *  started; another target is refused (409): the data went with that job. */
export function importPackageData(
  uploadId: string,
  body: { workspaceId: string; dataSourceId: string; viewId?: string | null; draftName?: string | null },
): Promise<PackageDataStarted> {
  return postJson<PackageDataStarted>(`/packages/${uploadId}/data`, body)
}

/** A view package, by its name or its first bytes (a zip). */
export async function isViewPackage(file: File): Promise<boolean> {
  if (/\.view-package\.zip$/i.test(file.name)) return true
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04
  } catch {
    return false
  }
}
