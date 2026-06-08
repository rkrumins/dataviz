/**
 * Versioning API Service — the graph store's branch/commit/diff/merge surface.
 *
 * Mirrors `viewApiService` (camelCase wire, cookie+CSRF session), but talks to the
 * workspace-scoped versioning router at `/api/v1/{wsId}/versioning/...`. Reads of a
 * draft's *graph* (nodes/edges/trace) still go through the normal `/graph` endpoints
 * with `?branchId=` (see `RemoteGraphProvider`); this service owns the lifecycle —
 * resolve a data source to its graph, open/list drafts, stage + commit edits, diff a
 * draft against main, and the publish / merge-request path.
 *
 * Conflict-aware by design: `stageChanges`/`commitDraft`/`publish`/`merge` can return
 * `409 merge_conflict` (main moved) or `422 ontology_violation`; both surface as typed
 * errors so the UI can route to a resolution flow instead of a generic toast.
 */
import { fetchWithTimeout } from './fetchWithTimeout'
import { useHealthStore } from '@/store/health'

// ============================================
// Wire types (match the backend `_ApiModel` aliases — camelCase)
// ============================================

export interface DraftRef {
  branchId: string
  headCommitId?: string | null
  baseCommitSeq?: number | null
}

export interface ResolveResponse {
  graphId: string
  mainBranchId: string
  mainHeadCommitSeq: number
  myDraft?: DraftRef | null
}

export type BranchKind = 'main' | 'draft' | 'fork'

export interface Branch {
  branchId: string
  kind: BranchKind
  name?: string | null
  owner?: string | null
  status: string
  baseCommitSeq?: number | null
  headCommitId?: string | null
  originatingViewId?: string | null
  createdBy?: string | null
  createdAt: string
  updatedAt: string
}

export interface Graph {
  graphId: string
  workspaceId: string
  tenantId?: string | null
  kind: string
  baseOntologyId?: string | null
  forkParentGraphId?: string | null
  forkBaseCommitSeq?: number | null
  mainHeadCommitSeq: number
  createdBy?: string | null
  createdAt: string
}

/** One normalized op for the staging buffer — `entityKind`/`entityId` mirror the wire. */
export interface StageOp {
  op: 'create' | 'update' | 'delete'
  entityKind: 'node' | 'edge'
  entityId?: string
  payload?: Record<string, unknown> | null
  ref?: string
  changeReason?: string
}

export interface StageResponse {
  /** ref-or-entityId → assigned entityId (creates get a minted id). */
  assigned: Record<string, string>
  count: number
}

export interface CheckpointResponse {
  commitId?: string | null
  stagedChanges: boolean
}

export interface CommitResponse {
  commitId: string
}

export interface Watermark {
  committed: number
  projected: number
  fresh: boolean
}

export interface StateResponse {
  nodes: Record<string, Record<string, unknown>>
  edges: Record<string, Record<string, unknown>>
  watermark?: Watermark | null
}

/** Raw id-keyed diff (`GET /diff`). Prefer `DiffVsMainResponse` for the overlay. */
export interface DiffResponse {
  added: string[]
  removed: string[]
  modified: Record<string, Record<string, unknown>>
}

/** One changed entity with whole-payload before/after — drives the canvas overlay. */
export interface DiffEntry {
  entityId: string
  kind: 'node' | 'edge'
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

export interface DiffVsMainResponse {
  added: DiffEntry[]
  removed: DiffEntry[]
  modified: DiffEntry[]
}

export interface CommitLogResponse {
  commits: Array<Record<string, unknown>>
}

export interface EntityHistoryResponse {
  entityId: string
  versions: Array<Record<string, unknown>>
}

export interface MergePreviewResponse {
  clean: boolean
  conflicts: Array<Record<string, unknown>>
  changes: Record<string, number>
}

export interface PullRequest {
  prId: string
  graphId: string
  sourceBranchId: string
  targetGraphId: string
  targetBranch: string
  baseCommitSeq?: number | null
  status: string
  title?: string | null
  description?: string | null
  conflicts?: Array<Record<string, unknown>> | null
  resultingCommitId?: string | null
  reviewers?: string[] | null
  approvedBy?: string[] | null
  approvalStatus?: string | null
  checksStatus?: Record<string, unknown> | null
  actor?: string | null          // who raised it
  createdAt: string              // when raised
  updatedAt: string
  mergedAt?: string | null       // when + who merged
  mergedBy?: string | null
  closedAt?: string | null       // when + who closed
  closedBy?: string | null
}

/** Map of entityId → resolved payload (or `null` to delete) for conflict resolution. */
export type ResolutionMap = Record<string, Record<string, unknown> | null>

// ============================================
// Typed domain errors (conflict-aware paths)
// ============================================

export class MergeConflictError extends Error {
  conflicts: Array<Record<string, unknown>>
  constructor(conflicts: Array<Record<string, unknown>>) {
    super('Main has moved — there are conflicting changes to resolve.')
    this.name = 'MergeConflictError'
    this.conflicts = conflicts
  }
}

export class OntologyViolationError extends Error {
  violations: Array<Record<string, unknown>>
  constructor(violations: Array<Record<string, unknown>>) {
    super('These changes violate the active ontology.')
    this.name = 'OntologyViolationError'
    this.violations = violations
  }
}

// ============================================
// Fetch helper — JSON + structured domain errors
// ============================================

async function vfetch<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetchWithTimeout(url, init)
  } catch (err) {
    useHealthStore.getState().reportFailure(err)
    throw err
  }
  if (!res.ok) {
    const text = await res.text()
    let body: any = null
    try {
      body = JSON.parse(text)
    } catch {
      /* non-JSON error body */
    }
    const detail = body?.detail
    if (res.status === 409 && detail?.type === 'merge_conflict') {
      throw new MergeConflictError(detail.conflicts ?? [])
    }
    if (res.status === 422 && detail?.type === 'ontology_violation') {
      throw new OntologyViolationError(detail.violations ?? [])
    }
    if (res.status === 401) throw new Error('Session expired')
    const msg =
      typeof detail === 'string'
        ? detail
        : detail?.message
        ? detail.message
        : detail
        ? JSON.stringify(detail)
        : text || res.statusText
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const base = (wsId: string) => `/api/v1/${wsId}/versioning`
const jsonBody = (data: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(data) })

// ============================================
// Resolve / graph lifecycle
// ============================================

/** Boot lookup: resolve a data source to its versioned graph + the caller's open draft (read-only — does NOT open one). */
export function resolveGraph(wsId: string, dataSourceId: string): Promise<ResolveResponse> {
  return vfetch<ResolveResponse>(`${base(wsId)}/resolve?dataSourceId=${encodeURIComponent(dataSourceId)}`)
}

/** Resolve and open a draft if the caller has none (requires `:manage`). */
export function resolveAndOpenDraft(
  wsId: string,
  data: { dataSourceId: string; originatingViewId?: string },
): Promise<ResolveResponse> {
  return vfetch<ResolveResponse>(`${base(wsId)}/resolve`, jsonBody(data))
}

export function getGraph(wsId: string, graphId: string): Promise<Graph> {
  return vfetch<Graph>(`${base(wsId)}/graphs/${graphId}`)
}

export interface BootstrapResult {
  graphId?: string
  nodes?: number
  edges?: number
  [k: string]: unknown
}

/**
 * "Enable version control" — create-or-seed the data source's versioned graph from
 * its current live state (idempotent). Note: this is on the *graph* route, not the
 * versioning route, because it snapshots the live provider into the versioned base.
 */
export function bootstrapGraph(wsId: string, dataSourceId: string): Promise<BootstrapResult> {
  return vfetch<BootstrapResult>(
    `/api/v1/${wsId}/graph/bootstrap?dataSourceId=${encodeURIComponent(dataSourceId)}`,
    { method: 'POST' },
  )
}

// ============================================
// Branches / drafts
// ============================================

export function listBranches(wsId: string, graphId: string): Promise<Branch[]> {
  return vfetch<Branch[]>(`${base(wsId)}/graphs/${graphId}/branches`)
}

export function openDraft(
  wsId: string,
  graphId: string,
  data: { name?: string; originatingViewId?: string; shared?: boolean } = {},
): Promise<{ branchId: string }> {
  return vfetch<{ branchId: string }>(`${base(wsId)}/graphs/${graphId}/branches`, jsonBody(data))
}

export function abandonDraft(wsId: string, graphId: string, branchId: string): Promise<Branch> {
  return vfetch<Branch>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/abandon`, jsonBody({}))
}

// ============================================
// Draft edits — stage + commit (one logical "save")
// ============================================

export function stageChanges(
  wsId: string,
  graphId: string,
  branchId: string,
  ops: StageOp[],
): Promise<StageResponse> {
  return vfetch<StageResponse>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/changes`,
    jsonBody({ ops }),
  )
}

export function commitDraft(
  wsId: string,
  graphId: string,
  branchId: string,
  data: { message?: string; resolutions?: ResolutionMap } = {},
): Promise<CheckpointResponse> {
  return vfetch<CheckpointResponse>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/commit`,
    jsonBody(data),
  )
}

/** One typed canvas edit for the atomic `/graph/changes` save. `update` payloads are
 *  partial — the server merges them onto current state. */
export interface GraphChangeOp {
  op: 'create' | 'update' | 'delete'
  kind: 'node' | 'edge'
  id?: string
  ref?: string
  payload?: Record<string, unknown> | null
}

export interface GraphChangesResult {
  commitId?: string | null
  assigned: Record<string, string>
}

/**
 * The unified draft-save path: apply a batch of canvas edits to a draft as ONE atomic,
 * server-merged commit (create/update/delete, nodes + edges). On the *graph* route
 * because it edits graph entities; `update` ops send only changed fields.
 */
export function applyGraphChanges(
  wsId: string,
  dataSourceId: string,
  branchId: string,
  ops: GraphChangeOp[],
  message?: string,
): Promise<GraphChangesResult> {
  const qs = `dataSourceId=${encodeURIComponent(dataSourceId)}&branchId=${encodeURIComponent(branchId)}`
  return vfetch<GraphChangesResult>(`/api/v1/${wsId}/graph/changes?${qs}`, {
    method: 'POST',
    body: JSON.stringify({ ops, message }),
  })
}

/**
 * Stage a batch of ops and fold them into one commit — the staged-changes "Save".
 * Returns the `assigned` temp-id→real-id map (from staging) and the new commit id.
 */
export async function saveDraft(
  wsId: string,
  graphId: string,
  branchId: string,
  ops: StageOp[],
  message?: string,
): Promise<{ assigned: Record<string, string>; commitId?: string | null }> {
  const staged = await stageChanges(wsId, graphId, branchId, ops)
  const committed = await commitDraft(wsId, graphId, branchId, { message })
  return { assigned: staged.assigned, commitId: committed.commitId }
}

// ============================================
// Reads / audit
// ============================================

export function getBranchState(
  wsId: string,
  graphId: string,
  branchId: string,
  asOfSeq?: number,
): Promise<StateResponse> {
  const qs = asOfSeq != null ? `?asOfSeq=${asOfSeq}` : ''
  return vfetch<StateResponse>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/state${qs}`)
}

export function getCommitState(wsId: string, graphId: string, commitId: string): Promise<StateResponse> {
  return vfetch<StateResponse>(`${base(wsId)}/graphs/${graphId}/commits/${commitId}/state`)
}

export function getCommitLog(
  wsId: string,
  graphId: string,
  params: { branchId?: string; limit?: number; offset?: number } = {},
): Promise<CommitLogResponse> {
  const sp = new URLSearchParams()
  if (params.branchId) sp.set('branchId', params.branchId)
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  const qs = sp.toString()
  return vfetch<CommitLogResponse>(`${base(wsId)}/graphs/${graphId}/commits${qs ? `?${qs}` : ''}`)
}

export function getEntityHistory(
  wsId: string,
  graphId: string,
  entityId: string,
): Promise<EntityHistoryResponse> {
  return vfetch<EntityHistoryResponse>(`${base(wsId)}/graphs/${graphId}/entities/${encodeURIComponent(entityId)}/history`)
}

export function getDiff(
  wsId: string,
  graphId: string,
  branchId: string,
  fromSeq: number,
  toSeq: number,
): Promise<DiffResponse> {
  return vfetch<DiffResponse>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/diff?fromSeq=${fromSeq}&toSeq=${toSeq}`,
  )
}

/** UI-shaped diff of a draft vs its base (whole payloads + before/after). */
export function getDiffVsMain(wsId: string, graphId: string, branchId: string): Promise<DiffVsMainResponse> {
  return vfetch<DiffVsMainResponse>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/diff-vs-main`)
}

/** What deleting a node would remove on a draft: its containment subtree (nodes) + every
 *  incident edge. Read-only, on-demand — powers the pre-commit cascade preview. */
export interface DeleteImpact {
  nodes: Array<Record<string, unknown>>
  edges: Array<Record<string, unknown>>
  /** True totals (the `nodes`/`edges` lists are capped for the UI). */
  nodeTotal: number
  edgeTotal: number
}

export function getDeleteImpact(
  wsId: string,
  dataSourceId: string,
  branchId: string,
  urn: string,
): Promise<DeleteImpact> {
  const qs = `dataSourceId=${encodeURIComponent(dataSourceId)}&branchId=${encodeURIComponent(branchId)}`
  return vfetch<DeleteImpact>(`/api/v1/${wsId}/graph/nodes/${encodeURIComponent(urn)}/delete-impact?${qs}`)
}

// ============================================
// Publish / merge-request path
// ============================================

export function mergePreview(wsId: string, graphId: string, branchId: string): Promise<MergePreviewResponse> {
  return vfetch<MergePreviewResponse>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/merge-preview`)
}

/** Direct publish of a draft → main (the `:manage` shortcut). */
export function publishBranch(
  wsId: string,
  graphId: string,
  branchId: string,
  data: { message: string; resolutions?: ResolutionMap },
): Promise<CommitResponse> {
  return vfetch<CommitResponse>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/publish`, jsonBody(data))
}

export function openMergeRequest(
  wsId: string,
  graphId: string,
  branchId: string,
  data: { title?: string; description?: string; reviewers?: string[] } = {},
): Promise<{ prId: string }> {
  return vfetch<{ prId: string }>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/merge-requests`,
    jsonBody(data),
  )
}

export function listMergeRequests(wsId: string, graphId: string): Promise<PullRequest[]> {
  return vfetch<PullRequest[]>(`${base(wsId)}/graphs/${graphId}/merge-requests`)
}

export function getMergeRequest(wsId: string, prId: string): Promise<PullRequest> {
  return vfetch<PullRequest>(`${base(wsId)}/merge-requests/${prId}`)
}

export function previewMergeRequest(wsId: string, prId: string): Promise<MergePreviewResponse> {
  return vfetch<MergePreviewResponse>(`${base(wsId)}/merge-requests/${prId}/preview`)
}

export function approveMergeRequest(wsId: string, prId: string): Promise<PullRequest> {
  return vfetch<PullRequest>(`${base(wsId)}/merge-requests/${prId}/approve`, jsonBody({}))
}

export function closeMergeRequest(wsId: string, prId: string): Promise<PullRequest> {
  return vfetch<PullRequest>(`${base(wsId)}/merge-requests/${prId}/close`, jsonBody({}))
}

export function mergeMergeRequest(
  wsId: string,
  prId: string,
  data: { message: string; resolutions?: ResolutionMap },
): Promise<CommitResponse> {
  return vfetch<CommitResponse>(`${base(wsId)}/merge-requests/${prId}/merge`, jsonBody(data))
}

/** Itemised "Files Changed" for a PR (draft MR or fork PR — the endpoint dispatches
 *  internally), in the same shape as a branch's diff-vs-main so it renders through the
 *  unified ChangesPanel. Counts match {@link previewMergeRequest}. */
export function getMergeRequestDiff(wsId: string, prId: string): Promise<DiffVsMainResponse> {
  return vfetch<DiffVsMainResponse>(`${base(wsId)}/merge-requests/${prId}/diff`)
}
