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
  /** The view the draft was opened from (branch-level attribution; null for
   *  drafts that predate view tracking until their owner next edits from a view). */
  originatingViewId?: string | null
}

export interface ResolveResponse {
  graphId: string
  mainBranchId: string
  mainHeadCommitSeq: number
  myDraft?: DraftRef | null
  /** Graph provenance — "blank" for self-serve blank models, else the seed kind. */
  kind?: string
  /** The in-flight (or failed) "enable version control" job — present only while the
   *  graph is still at genesis, so a reload lands back on live progress. */
  bootstrap?: BootstrapJob | null
}

/** Result of provisioning a blank lineage model (data source + genesis graph). */
export interface BlankGraphResult {
  dataSourceId: string
  graphId: string
  mainBranchId: string
  graphName: string
  label: string
}

export type BranchKind = 'main' | 'draft' | 'fork'

export interface Branch {
  branchId: string
  kind: BranchKind
  name?: string | null
  description?: string | null
  owner?: string | null
  isShared?: boolean
  status: string
  baseCommitSeq?: number | null
  headCommitId?: string | null
  originatingViewId?: string | null
  createdBy?: string | null
  createdAt: string
  updatedAt: string
  /** owner/createdBy id → resolved display name; unresolvable ids are absent. */
  userNames?: Record<string, string>
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
  /** createdBy id → resolved display name; unresolvable ids are absent. */
  userNames?: Record<string, string>
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
  status?: string   // idle | projecting | rebuilding | evicted — only projecting/rebuilding = actively catching up
  /** Seq the projection is catching up TO (0 when no projection state exists). */
  target?: number
  /** Why the last projection pass stopped — `idle && !fresh && lastError` = it FAILED
   *  (not merely pending); the Data health UI surfaces this as a terminal state. */
  lastError?: string | null
  lastProjectedAt?: string | null
  /** Live full-rebuild progress (items applied / total); null unless a full seed is running. */
  progressDone?: number | null
  progressTotal?: number | null
}

/** Result of kicking a full rebuild of the fast read layer. `alreadyRunning` ⇒ a
 *  projection/rebuild was already in flight, so this was a no-op. */
export interface RebuildResponse {
  started: boolean
  alreadyRunning: boolean
  watermark: Watermark
}

/** One node drifted between the source of truth and the fast read layer — enough to name it. */
export interface DriftNodeSample {
  entityId: string
  urn?: string | null
  displayName?: string | null
}

/** One field whose cached value diverged from the source of truth (deep check only). */
export interface DriftMismatch {
  entityId: string
  field: string
  pg?: unknown
  falkor?: unknown
}

/**
 * Drift report: the fast read layer compared against the source of truth. `inSync` ⇒ they match.
 * `skippedReason` (set) ⇒ the check couldn't run (no target / a refresh in flight) and the counts
 * are meaningless. Sample lists are bounded; `truncated` ⇒ more drift exists than is listed.
 */
export interface DriftReport {
  graphId: string
  falkorGraphName?: string | null
  committedSeq: number
  projectedSeq: number
  status: string
  fresh: boolean
  pgNodes: number
  pgEdges: number
  falkorNodes: number
  falkorEdges: number
  missingNodes: DriftNodeSample[]
  extraNodes: DriftNodeSample[]
  missingEdges: string[]
  extraEdges: string[]
  mismatched: DriftMismatch[]
  truncated: boolean
  inSync: boolean
  checkedAt: string
  durationMs: number
  skippedReason?: string | null
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

/** One row of the hierarchical diff. `kind`: a `container` (expandable, nests changed
 *  descendants), a `bucket` (type/edgeType grouping of parent-less changes), or a `leaf`
 *  (a single change with whole-payload before/after). `childTotal > 0` ⇒ expandable. */
export interface DiffTreeNode {
  key: string
  kind: 'container' | 'bucket' | 'leaf'
  entityKind?: 'node' | 'edge'   // 'edge' = a relationship change (source → target); else an entity
  label: string
  entityType?: string | null
  status?: 'added' | 'modified' | 'removed' | 'unchanged' | null
  counts: { added: number; modified: number; removed: number }
  childTotal: number
  deleted: boolean
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

/** Top of the hierarchical diff: capped top-level groups + global counts (== the flat
 *  diff's) + an entityType impact rollup for the summary header. */
export interface DiffSummaryResponse {
  groups: DiffTreeNode[]
  groupTotal: number
  counts: { added: number; modified: number; removed: number }
  /** Split of `counts`: entities (nodes) vs relationships (non-containment edges). */
  entityCounts?: { added: number; modified: number; removed: number }
  edgeCounts?: { added: number; modified: number; removed: number }
  impact: Record<string, number>
}

export interface DiffChildrenResponse {
  entries: DiffTreeNode[]
  total: number
}

/** Active-PR counts for a view's canvas indicator. */
export interface ViewPrCounts {
  fromView: number
  onDataSource: number
}

export interface CommitLogResponse {
  commits: Array<Record<string, unknown>>
  /** actor/contributor id → resolved display name, covering every commit in this response. */
  userNames?: Record<string, string>
}

export interface EntityHistoryResponse {
  entityId: string
  versions: Array<Record<string, unknown>>
  /** version actor id → resolved display name, covering every version in this response. */
  userNames?: Record<string, string>
}

export interface MergePreviewResponse {
  clean: boolean
  conflicts: Array<Record<string, unknown>>
  changes: Record<string, number>
}

/** Result of pulling latest main into a draft (`POST .../rebase`). `clean: false` ⇒
 *  `conflicts` need resolving, then resubmit with `resolutions`. */
export interface RebaseResponse {
  clean: boolean
  conflicts: Array<Record<string, unknown>>
  changes?: Record<string, number>
  baseCommitSeq?: number | null
  alreadyUpToDate?: boolean
}

export interface PullRequest {
  prId: string
  graphId: string
  sourceBranchId: string
  sourceBranchOwner?: string | null   // owner of the source draft (only on the single-PR read)
  sourceBranchName?: string | null
  originatingViewId?: string | null   // the view the source draft belongs to — for "back to view" nav
  targetGraphId: string
  targetBranch: string
  baseCommitSeq?: number | null
  behind?: boolean | null         // draft MR: base lags main head — must pull latest before merge
  behindBy?: number | null
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
  /** every actor id this PR references (actor/reviewers/approvedBy/mergedBy/closedBy/
   *  sourceBranchOwner) → resolved display name; unresolvable ids are absent. */
  userNames?: Record<string, string>
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
    const reasons = violations.map((v) => v?.reason).filter(Boolean).slice(0, 2) as string[]
    super(
      reasons.length
        ? `These changes violate the active ontology. ${reasons.join(' ')}`
        : 'These changes violate the active ontology.',
    )
    this.name = 'OntologyViolationError'
    this.violations = violations
  }
}

/** A draft is behind main and must pull the latest changes before it can be merged. */
export class NotUpToDateError extends Error {
  branchId?: string
  behindBy?: number
  constructor(detail: { branchId?: string; behindBy?: number; message?: string }) {
    super(detail.message || 'This draft is out of date — pull the latest changes before merging.')
    this.name = 'NotUpToDateError'
    this.branchId = detail.branchId
    this.behindBy = detail.behindBy
  }
}

// ============================================
// Fetch helper — JSON + structured domain errors
// ============================================

async function vfetch<T>(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
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
    if (res.status === 409 && detail?.type === 'not_up_to_date') {
      throw new NotUpToDateError(detail)
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

/** Boot lookup: resolve a data source to its versioned graph + the caller's open draft
 *  (read-only — does NOT open one). Pass `viewId` to scope the draft lookup to that Context
 *  View (branch-per-view) — omitted, the backend falls back to its legacy most-recent-draft
 *  behavior. */
export function resolveGraph(
  wsId: string, dataSourceId: string, viewId?: string | null,
): Promise<ResolveResponse> {
  const q = new URLSearchParams({ dataSourceId })
  if (viewId) q.set('viewId', viewId)
  return vfetch<ResolveResponse>(`${base(wsId)}/resolve?${q}`)
}

/**
 * Provision a blank lineage model: a manual data source + genesis versioned graph
 * bound to `providerId` and the published ontology `ontologyId`, in one call. The
 * 422 `provider_unsupported` / `ontology_not_published` details surface as the
 * thrown error's message (via `vfetch`), so the wizard can show them inline.
 */
export function provisionBlankGraph(
  wsId: string,
  req: { name: string; description?: string; providerId: string; ontologyId: string;
         graphName?: string },
): Promise<BlankGraphResult> {
  return vfetch<BlankGraphResult>(`${base(wsId)}/blank-graphs`, jsonBody(req))
}

export interface GraphNameCheck {
  available: boolean
  normalized: string
  reason?: string | null
}

/** Live availability check for a blank model's physical graph name — the same
 *  rules the provisioning endpoint enforces authoritatively (slug shape,
 *  reserved prefixes, per-provider uniqueness, live key check). */
export function checkBlankGraphName(
  wsId: string, providerId: string, graphName: string,
): Promise<GraphNameCheck> {
  const q = new URLSearchParams({ providerId, graphName })
  return vfetch<GraphNameCheck>(`${base(wsId)}/blank-graphs/name-check?${q}`)
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
  jobId?: string
  graphId?: string
  status?: BootstrapJobStatus
  alreadyEnabled?: boolean
}

export type BootstrapJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
export type BootstrapPhase =
  | 'counting' | 'nodes' | 'edges' | 'validate' | 'heads' | 'merkle' | 'finalize' | 'backfill'

/** One integrity check from the job's report — rendered verbatim in the report card. */
export interface BootstrapCheck {
  key: string
  ok: boolean
  detail: string
  blocking: boolean
}

export interface BootstrapReport {
  checks: BootstrapCheck[]
  source: { nodes: number; edges: number }
  stored: { nodes: number; edges: number }
  labels: Record<string, number>
  edgeTypes: Record<string, number>
  sampleChecked: number
  sampleMismatched: Array<Record<string, unknown>>
  mergedDuplicateConnections: number
  /** Entities with no identifier: invisible to the app (they never render, search or
   *  trace), so they were not copied — stated plainly rather than hidden. */
  skippedWithoutIdentifier?: { nodes: number; edges: number }
  merkle: 'inline' | 'deferred' | 'pending'
}

export interface BootstrapJob {
  jobId: string
  graphId: string
  status: BootstrapJobStatus
  phase: BootstrapPhase | null
  processed: number
  total: number
  percent: number
  startedAt?: string | null
  updatedAt?: string | null
  error?: string | null
  report?: BootstrapReport | null
}

/**
 * "Enable version control" — copy the data source's whole graph into the versioned
 * store. Returns **202 + a jobId**: the copy runs on the versioning worker in
 * resumable windows (a large graph can't be paged into one request), so callers poll
 * {@link getBootstrapStatus}. An already-versioned source returns `alreadyEnabled`.
 */
export function bootstrapGraph(wsId: string, dataSourceId: string): Promise<BootstrapResult> {
  return vfetch<BootstrapResult>(
    `/api/v1/${wsId}/graph/bootstrap?dataSourceId=${encodeURIComponent(dataSourceId)}`,
    { method: 'POST' },
  )
}

/** Live progress of the enablement job (404 → never started). */
export function getBootstrapStatus(wsId: string, dataSourceId: string): Promise<BootstrapJob> {
  return vfetch<BootstrapJob>(
    `/api/v1/${wsId}/graph/bootstrap/status?dataSourceId=${encodeURIComponent(dataSourceId)}`,
  )
}

/** `resume` continues from the last completed window; `restart` re-reads the source. */
export function retryBootstrap(
  wsId: string, dataSourceId: string, mode: 'resume' | 'restart' = 'resume',
): Promise<{ jobId: string; status: BootstrapJobStatus }> {
  return vfetch(
    `/api/v1/${wsId}/graph/bootstrap/retry?dataSourceId=${encodeURIComponent(dataSourceId)}&mode=${mode}`,
    { method: 'POST' },
  )
}

/** Give up: everything the job imported is removed and the source reads as before. */
export function abandonBootstrap(
  wsId: string, dataSourceId: string,
): Promise<{ jobId: string; status: BootstrapJobStatus }> {
  return vfetch(
    `/api/v1/${wsId}/graph/bootstrap/abandon?dataSourceId=${encodeURIComponent(dataSourceId)}`,
    { method: 'POST' },
  )
}

// ============================================
// Branches / drafts
// ============================================

/** Branches on a graph. Graph-wide (every view — the Data-Source rollup) by DEFAULT; pass
 *  `viewId` to get only that Context View's own branches (branch-per-view). The backend also
 *  scopes a non-manager to their own + shared drafts, so the switcher lists what the user owns
 *  or was invited to — not everyone's private drafts. */
export function listBranches(
  wsId: string, graphId: string, opts: { viewId?: string | null } = {},
): Promise<Branch[]> {
  const q = new URLSearchParams()
  if (opts.viewId) q.set('viewId', opts.viewId)
  const qs = q.toString()
  return vfetch<Branch[]>(`${base(wsId)}/graphs/${graphId}/branches${qs ? `?${qs}` : ''}`)
}

export function openDraft(
  wsId: string,
  graphId: string,
  data: { name?: string; originatingViewId?: string; shared?: boolean } = {},
): Promise<{ branchId: string }> {
  return vfetch<{ branchId: string }>(`${base(wsId)}/graphs/${graphId}/branches`, jsonBody(data))
}

/** Pull the latest main into a draft ("update branch"). Returns `{clean, conflicts, ...}`; on
 *  `clean: false` resolve the conflicts and resubmit with `resolutions`. */
export function rebaseDraft(
  wsId: string,
  graphId: string,
  branchId: string,
  data: { resolutions?: ResolutionMap } = {},
): Promise<RebaseResponse> {
  return vfetch<RebaseResponse>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/rebase`,
    jsonBody(data),
  )
}

/** Projection freshness for `main` — cheap (no state materialised); drives the "refreshing…" badge. */
export function getWatermark(wsId: string, graphId: string): Promise<Watermark> {
  return vfetch<Watermark>(`${base(wsId)}/graphs/${graphId}/watermark`)
}

export interface BranchFreshness {
  behind: boolean
  behindBy: number
  mainHeadCommitSeq: number
  baseCommitSeq: number
}

/** Live "is this draft behind main?" — O(1), safe to poll while editing so a branch owner learns a
 *  teammate published RIGHT AWAY (not at merge). */
export function getBranchFreshness(wsId: string, graphId: string, branchId: string): Promise<BranchFreshness> {
  return vfetch<BranchFreshness>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/freshness`)
}

/** Rebuild the fast read layer from the source of truth (full background replay). 409 when the graph
 *  has no fast-read-layer target. Idempotent — a rebuild already in flight returns `started:false`. */
export function rebuildProjection(wsId: string, graphId: string): Promise<RebuildResponse> {
  return vfetch<RebuildResponse>(`${base(wsId)}/graphs/${graphId}/projection/rebuild`, jsonBody({}))
}

/** Compare the fast read layer against the source of truth and report any drift. `deep` also
 *  field-compares every cached node (slower). 409 when a reconcile is already running for the graph. */
export function reconcileProjection(
  wsId: string,
  graphId: string,
  opts: { deep?: boolean } = {},
): Promise<DriftReport> {
  // Deep reconcile is a request-scoped full-graph scan — match the
  // backend's 120s versioning tier so the FE's 30s default doesn't
  // abort a legitimately long-running drift report first.
  return vfetch<DriftReport>(`${base(wsId)}/graphs/${graphId}/projection/reconcile`, {
    ...jsonBody({ deep: !!opts.deep }),
    timeoutMs: 120_000,
  })
}

export function abandonDraft(wsId: string, graphId: string, branchId: string): Promise<Branch> {
  return vfetch<Branch>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/abandon`, jsonBody({}))
}

/** Edit a draft's name / description / shared-visibility. PATCH: omitted fields are untouched;
 *  pass `''` to clear name/description. */
export function updateBranch(
  wsId: string,
  graphId: string,
  branchId: string,
  data: { name?: string; description?: string; isShared?: boolean },
): Promise<Branch> {
  return vfetch<Branch>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
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
  /** Optimistic-concurrency token: the `version` (content hash) the entity was read at. On an
   *  update the server 3-way merges against it so a concurrent same-field edit conflicts instead
   *  of silently overwriting. Omit ⇒ plain patch (no OCC). */
  baseVersion?: string
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
  params: {
    branchId?: string; originatingViewId?: string; publishedOnly?: boolean
    limit?: number; offset?: number
  } = {},
): Promise<CommitLogResponse> {
  const sp = new URLSearchParams()
  if (params.branchId) sp.set('branchId', params.branchId)
  if (params.originatingViewId) sp.set('originatingViewId', params.originatingViewId)
  if (params.publishedOnly) sp.set('publishedOnly', 'true')
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  const qs = sp.toString()
  return vfetch<CommitLogResponse>(`${base(wsId)}/graphs/${graphId}/commits${qs ? `?${qs}` : ''}`)
}

/** The raw draft commits squashed into a publish/merge commit — the "merged N commits"
 *  drill-down. Empty for a non-squash commit. */
export function getSquashedCommits(
  wsId: string,
  graphId: string,
  commitId: string,
  params: { limit?: number; offset?: number } = {},
): Promise<CommitLogResponse> {
  const sp = new URLSearchParams()
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  const qs = sp.toString()
  return vfetch<CommitLogResponse>(
    `${base(wsId)}/graphs/${graphId}/commits/${commitId}/squashed${qs ? `?${qs}` : ''}`,
  )
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

// ============================================
// Hierarchical (containment-tree) diff — lazy, capped, business-friendly
// ============================================

/** Top-level groups of a draft's changes as a containment tree (canvas Changes panel). */
export function getBranchDiffSummary(
  wsId: string, graphId: string, branchId: string, limit?: number,
): Promise<DiffSummaryResponse> {
  const qs = limit != null ? `?limit=${limit}` : ''
  return vfetch<DiffSummaryResponse>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/diff-vs-main/summary${qs}`,
  )
}

/** One group's direct children in a draft's hierarchical diff (lazy-load step). */
export function getBranchDiffChildren(
  wsId: string, graphId: string, branchId: string, containerKey: string,
  params: { limit?: number; offset?: number } = {},
): Promise<DiffChildrenResponse> {
  const sp = new URLSearchParams({ containerKey })
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  return vfetch<DiffChildrenResponse>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/diff-vs-main/children?${sp}`,
  )
}

/** Top-level groups of one commit's changes as a containment tree (History drill-down). */
export function getCommitDiffSummary(
  wsId: string, graphId: string, commitId: string, limit?: number,
): Promise<DiffSummaryResponse> {
  const qs = limit != null ? `?limit=${limit}` : ''
  return vfetch<DiffSummaryResponse>(
    `${base(wsId)}/graphs/${graphId}/commits/${encodeURIComponent(commitId)}/diff/summary${qs}`,
  )
}

/** One group's direct children in a commit's hierarchical diff (lazy-load step). */
export function getCommitDiffChildren(
  wsId: string, graphId: string, commitId: string, containerKey: string,
  params: { limit?: number; offset?: number } = {},
): Promise<DiffChildrenResponse> {
  const sp = new URLSearchParams({ containerKey })
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  return vfetch<DiffChildrenResponse>(
    `${base(wsId)}/graphs/${graphId}/commits/${encodeURIComponent(commitId)}/diff/children?${sp}`,
  )
}

/** Top-level groups of a PR's Files Changed as a containment tree. */
export function getMergeRequestDiffSummary(
  wsId: string, prId: string, limit?: number,
): Promise<DiffSummaryResponse> {
  const qs = limit != null ? `?limit=${limit}` : ''
  return vfetch<DiffSummaryResponse>(`${base(wsId)}/merge-requests/${prId}/diff/summary${qs}`)
}

/** One group's direct children in a PR's hierarchical diff (lazy-load step). */
export function getMergeRequestDiffChildren(
  wsId: string, prId: string, containerKey: string,
  params: { limit?: number; offset?: number } = {},
): Promise<DiffChildrenResponse> {
  const sp = new URLSearchParams({ containerKey })
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  return vfetch<DiffChildrenResponse>(`${base(wsId)}/merge-requests/${prId}/diff/children?${sp}`)
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

// ============================================
// Rollback: revert one commit / restore to a point in time
// ============================================

/** Undo ONE published commit as a new `revert` commit (keeps later work).
 *  409 `MergeConflictError` when later commits touched the same entities. */
export function revertCommit(
  wsId: string,
  graphId: string,
  commitId: string,
  message?: string,
): Promise<CommitResponse> {
  return vfetch<CommitResponse>(
    `${base(wsId)}/graphs/${graphId}/commits/${commitId}/revert`,
    jsonBody(message ? { message } : {}),
  )
}

/** Reset main to its state at `commitId` as ONE new `restore` commit —
 *  rolls back everything after it. Never conflicts; history is kept. */
export function restoreCommit(
  wsId: string,
  graphId: string,
  commitId: string,
  message?: string,
): Promise<CommitResponse> {
  return vfetch<CommitResponse>(
    `${base(wsId)}/graphs/${graphId}/commits/${commitId}/restore`,
    jsonBody(message ? { message } : {}),
  )
}

/** Impact a restore would have — powers the confirm dialog. Very large restores are
 *  priced coarsely (`approximate`) rather than dragging millions of payloads through a
 *  synchronous request just to render a dialog. */
export interface RestorePreview {
  commitsUndone: number
  nodes: { create: number; update: number; delete: number }
  edges: { create: number; update: number; delete: number }
  approximate?: boolean
  touchedEstimate?: number
}

export function getRestorePreview(
  wsId: string,
  graphId: string,
  commitId: string,
): Promise<RestorePreview> {
  return vfetch<RestorePreview>(
    `${base(wsId)}/graphs/${graphId}/commits/${commitId}/restore-preview`,
  )
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

// ============================================
// View- / data-source-scoped PR access (the canvas review layer)
// ============================================

/** PRs raised from a view (matched via the source branch's originating view). */
export function listViewPullRequests(
  wsId: string, viewId: string,
  params: { status?: string; limit?: number; offset?: number } = {},
): Promise<PullRequest[]> {
  const sp = new URLSearchParams()
  if (params.status) sp.set('status', params.status)
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  const qs = sp.toString()
  return vfetch<PullRequest[]>(
    `${base(wsId)}/views/${encodeURIComponent(viewId)}/pull-requests${qs ? `?${qs}` : ''}`,
  )
}

/** All PRs against a data source (every view on it). */
export function listDataSourcePullRequests(
  wsId: string, dataSourceId: string,
  params: { status?: string; limit?: number; offset?: number } = {},
): Promise<PullRequest[]> {
  const sp = new URLSearchParams()
  if (params.status) sp.set('status', params.status)
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.offset != null) sp.set('offset', String(params.offset))
  const qs = sp.toString()
  return vfetch<PullRequest[]>(
    `${base(wsId)}/data-sources/${encodeURIComponent(dataSourceId)}/pull-requests${qs ? `?${qs}` : ''}`,
  )
}

/** Active-PR counts for a view's indicator (from-this-view + on-its-data-source). */
export function getViewPrCounts(wsId: string, viewId: string): Promise<ViewPrCounts> {
  return vfetch<ViewPrCounts>(`${base(wsId)}/views/${encodeURIComponent(viewId)}/pull-requests/count`)
}

/** Edit a PR's title/description (review metadata). PATCH: omitted fields are untouched. */
export function updateMergeRequest(
  wsId: string,
  prId: string,
  data: { title?: string; description?: string },
): Promise<PullRequest> {
  return vfetch<PullRequest>(`${base(wsId)}/merge-requests/${prId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
