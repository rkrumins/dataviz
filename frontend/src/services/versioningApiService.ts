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
 * errors so the UI can route to a resolution flow instead of a generic notification.
 */
import type { ViewDefinitionDiff } from '@/services/viewVersionsApiService'
import type { GraphEdge, GraphNode } from '@/providers/GraphDataProvider'
import { fetchWithTimeout } from './fetchWithTimeout'
import { pollJob } from './importExportApiService'
import { useHealthStore } from '@/store/health'
import { readJsonLossless } from '@/lib/losslessJson'

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
  /** Health of the derived lineage summaries (`:AGGREGATED`) — "missing"/"untrusted" means
   *  "Rebuild fast read layer" hands them to the aggregation job to re-derive. */
  rollups?: { status: 'ok' | 'missing' | 'untrusted'; aggregated: number; stubs: number } | null
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
  /** A draft with more changes than the tree lists: counts only, no groups. */
  tooLarge?: { changed: number; limit: number }
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

/** What one revision changed: a field (`[name]`) or a property (`['properties', name]`). */
export interface RevisionChange {
  path: string[]
  kind: 'added' | 'removed' | 'changed'
  before: unknown
  after: unknown
}

/** One revision of an entity, as the paged history returns it. */
export interface EntityRevision {
  id: string
  commit_id: string
  commit_seq: number
  branch_id: string
  op: 'create' | 'update' | 'delete'
  content_hash: string
  prev_content_hash?: string | null
  actor?: string | null
  change_reason?: string | null
  created_at: string
  commit_kind?: string | null
  commit_message?: string | null
  /** Against the value it was made from; `null` when that value is no longer on record. */
  changes: RevisionChange[] | null
  /** The draft's own revision (not yet published). */
  on_draft: boolean
  /** Published after the draft being viewed branched — the draft does not have it. */
  after_branch_point: boolean
  payload?: Record<string, unknown> | null
}

export interface EntityHistoryResponse {
  entityId: string
  kind?: 'node' | 'edge' | null
  versions: EntityRevision[]
  /** version actor id → resolved display name, covering every version in this response. */
  userNames?: Record<string, string>
  hasMore: boolean
  /** Pass back as `before` for the next (older) page. */
  nextBefore?: string | null
}

export type HistoryScope = 'all' | 'draft' | 'published'

/** One event in an entity's life, as the summary reports it. */
export interface EntityEvent {
  at: string
  actor?: string | null
  op: 'create' | 'update' | 'delete'
  commitId: string
  inDraft: boolean
}

/** An entity as a reader returns it now, with the token its next edit echoes. */
export type EntityView =
  | { kind: 'node'; version: string; node: GraphNode; deleted?: undefined }
  | { kind: 'edge'; version: string; edge: GraphEdge; deleted?: undefined }
  | { kind: 'node' | 'edge'; version: null; deleted: true }

export interface EntitySummary {
  entityId: string
  kind: 'node' | 'edge'
  exists: boolean
  version?: string | null
  /** A fork's entity it never changed — its parent's. */
  inherited: boolean
  created?: EntityEvent | null
  updated?: EntityEvent | null
  revisions: { published: number; draft: number }
  /** Viewing a draft: main changed this entity after the draft branched. */
  changedOnMainSinceBranch: boolean
  baseCommitSeq?: number | null
  /** With `includeValue`: the entity as the line has it, and its token. */
  value?: EntityView | null
  userNames?: Record<string, string>
}

export interface MergePreviewResponse {
  clean: boolean
  conflicts: Array<Record<string, unknown>>
  changes: Record<string, number>
}

/** Result of pulling latest main into a draft (`POST .../rebase`). `clean: false` ⇒
 *  `conflicts` need resolving, then resubmit with `resolutions`. */
/** What a pull brought in from Published — the upstream commits it folded into the draft, and their
 *  NET effect on state.
 *
 *  `branchId` + `fromSeq`/`toSeq` fully identify the window (commit_seq is PER-BRANCH, so the seqs
 *  are meaningless without the branch they belong to), which makes this self-describing: a caller can
 *  fetch the diff with nothing but this object. That matters — the main branch id otherwise lives only
 *  in `branchStore`, which the canvas populates, and a reviewer pulling from the Reviews inbox has no
 *  canvas mounted. */
export interface IncomingChanges {
  branchId: string | null
  commitIds: string[]
  commitCount: number
  contributors: string[]
  stats: { create: number; update: number; delete: number }
  fromSeq: number
  toSeq: number
}

export interface RebaseResponse {
  clean: boolean
  conflicts: Array<Record<string, unknown>>
  /** On conflict: the draft's own value of each conflicting entity, to resolve from. */
  seeds?: Record<string, Record<string, unknown> | null>
  /** How YOUR OWN edits had to be rewritten to sit on the new base — usually nothing. */
  changes?: Record<string, number>
  /** What actually arrived from Published. Distinct from `changes`; conflating the two is why a
   *  pull could never say what it had pulled. */
  incoming?: IncomingChanges | null
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
  /** HOW it merged: 'review' (through this PR) or 'direct_publish' (a manager published the source
   *  branch straight to Published, which lands the same changes and so resolves this PR). */
  mergedVia?: 'review' | 'direct_publish' | null
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
  /** A draft save's conflicts: each conflicting entity as it is now — what an edit rebases onto. */
  current: Record<string, EntityView>
  constructor(conflicts: Array<Record<string, unknown>>, current: Record<string, EntityView> = {}) {
    super(Object.keys(current).length > 0
      ? `Someone else changed ${conflicts.length === 1 ? 'a field' : 'fields'} you edited.`
      : 'Main has moved — there are conflicting changes to resolve.')
    this.name = 'MergeConflictError'
    this.conflicts = conflicts
    this.current = current
  }
}

/** A save refused because it would leave the graph inconsistent (a relationship whose end was
 *  removed, …) or because the draft kept moving under it. Nothing was saved. */
export class IntegrityError extends Error {
  constructor(message?: string) {
    super(message || 'The draft changed while saving — nothing was saved. Try again.')
    this.name = 'IntegrityError'
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

/** This branch already has an open review, and a branch may have only one — its new changes are
 *  already part of that review. Carries `prId` so the caller can route the user TO it rather than
 *  dead-ending them. (The UI normally prevents this; this is the race backstop.) */
export class PullRequestExistsError extends Error {
  prId: string
  branchId?: string
  prTitle?: string | null
  constructor(detail: { prId: string; branchId?: string; title?: string | null; message?: string }) {
    super(detail.message || 'This branch is already in review.')
    this.name = 'PullRequestExistsError'
    this.prId = detail.prId
    this.branchId = detail.branchId
    this.prTitle = detail.title ?? null
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
    throw versioningError(res.status, body?.detail, text || res.statusText)
  }
  if (res.status === 204) return undefined as T
  return readJsonLossless<T>(res)
}

/** A refusal's `detail`: a message, or an object whose `type` names the refusal. */
type RefusalDetail = string | {
  type?: string
  message?: string
  conflicts?: Array<Record<string, unknown>>
  /** A merge conflict's entities as they are now, by id. */
  current?: Record<string, unknown>
  violations?: Array<Record<string, unknown>>
  branchId?: string
  behindBy?: number
  prId?: string
  title?: string | null
  suggestion?: string | null
} | null | undefined

/** The error a versioning API refusal (`status`, `detail`) raises — the same whether it came back
 *  from the request or from a job the request queued (a large draft's publish). */
function versioningError(status: number, detail: RefusalDetail, fallback: string): Error {
  const d = typeof detail === 'object' && detail ? detail : undefined
  if (status === 409 && d?.type === 'merge_conflict') {
    return new MergeConflictError(d.conflicts ?? [], (d.current ?? {}) as Record<string, EntityView>)
  }
  if (status === 409 && d?.type === 'integrity') {
    return new IntegrityError(d.message)
  }
  if (status === 422 && d?.type === 'ontology_violation') {
    return new OntologyViolationError(d.violations ?? [])
  }
  if (status === 409 && d?.type === 'not_up_to_date') {
    return new NotUpToDateError(d)
  }
  if (status === 409 && d?.type === 'pull_request_exists') {
    return new PullRequestExistsError(d as { prId: string })
  }
  if (status === 422 && d?.type === 'graph_name_unavailable') {
    return new GraphNameUnavailableError(
      d.message ?? 'That graph name is already taken on this connection.',
      d.suggestion ?? null,
    )
  }
  if (status === 409 && (d?.type === 'stale_decision' || d?.type === 'not_awaiting_decision')) {
    return new BootstrapDecisionError(d.type, d.message)
  }
  if (status === 401) return new Error('Session expired')
  const msg =
    typeof detail === 'string'
      ? detail
      : d?.message
      ? d.message
      : d
      ? JSON.stringify(d)
      : fallback
  return new Error(msg)
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
  /** A free name when this one is taken ("data_lineage" → "data_lineage_2"). */
  suggestion?: string | null
}

/**
 * The physical graph name was taken by the time we tried to provision.
 *
 * Worth its own type: the graph name IS the FalkorDB key the model writes into,
 * so the server refuses rather than reusing it (a projection seed would wipe
 * whatever lives there). Retrying the same name can therefore only fail again —
 * the caller needs `suggestion` to offer a way forward.
 */
export class GraphNameUnavailableError extends Error {
  readonly suggestion: string | null
  constructor(message: string, suggestion: string | null) {
    super(message)
    this.name = 'GraphNameUnavailableError'
    this.suggestion = suggestion
  }
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

/** `needs_decision`: paused before copying anything, because the source uses some identifiers
 *  more than once (see {@link BootstrapDuplicates}); it waits for a manager to decide. */
export type BootstrapJobStatus = 'pending' | 'running' | 'needs_decision' | 'completed' | 'failed' | 'cancelled'
export type BootstrapPhase =
  | 'reset' | 'counting' | 'awaiting_decision' | 'nodes' | 'edges' | 'validate' | 'heads' | 'merkle'
  | 'finalize' | 'backfill'

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
  /** What it copies from: the data source's graph, or (a seed) a view package. */
  origin?: 'graph' | 'package'
  /** Waiting its turn: how many enablement jobs are ahead of it; else null. */
  queuedAhead?: number | null
  /** Each time a server takes the job up is one attempt: past the first, it resumed where an
   *  earlier one stopped. */
  attempt?: number
  /** Running, but its server stopped answering: another one is about to take it over. */
  stale?: boolean
  /** A failed job: why, and what can be done about it. */
  failure?: JobFailure | null
  /** Identifiers the source uses more than once, found before anything is copied; null if none. */
  duplicates?: BootstrapDuplicates | null
  /** What the copy turned away: duplicates that appeared after the check, and connections whose
   *  ends are missing. */
  rejected?: { duplicateUrns: number; danglingEdges: number; samples: Array<Record<string, unknown>> } | null
  /** What collapsing the duplicates removed: the extra copies (by type), and the connections that
   *  only joined two copies of one item. */
  collapsed?: { nodes: number; byLabel: Record<string, number>; selfLoops: number } | null
  /** Connections whose id was already an item's, so they were given a new one. */
  rekeyedEdges?: number
  /** Set once duplicate copies may have been removed from the source graph — kept through a
   *  restart, since nothing puts them back. */
  sourceCollapse?: { moved: number; deleted: number } | null
}

/** Why a job failed, and what can be done: an `integrity` failure (the copy didn't match its source)
 *  only fails the same way again unless it is restarted; an `infrastructure` one resumes where it
 *  stopped; an `internal` one is a bug, which no action fixes. */
export interface JobFailure {
  code: 'integrity' | 'infrastructure' | 'internal'
  action: 'restart' | 'resume' | null
  phase?: string | null
  reason?: string | null
}

/** One copy of a duplicated identifier. `internalId` is the source graph's own id for the item
 *  (the tie-break); `kept` marks the copy that collapsing keeps. */
export interface BootstrapDuplicateCopy {
  urn: string
  label: string | null
  internalId: number
  lastSyncedAt: string | null
  kept: boolean
}

/** The duplicate identifiers the pre-flight found. Collapsing keeps one copy of each (`rule`: the
 *  latest `lastSyncedAt`, then the lowest internal id). `fingerprint` names exactly this list: a
 *  decision carries it, so it can only ever apply to the list the manager was shown. */
export interface BootstrapDuplicates {
  identifiers: number
  extraCopies: number
  /** Of `identifiers`: those whose copies all share one type, and those whose copies differ. */
  sameType: number
  crossType: number
  rule: string
  fingerprint: string
  detectedAt: string
  /** At most 20 copies; the whole list is {@link getBootstrapDuplicates}, or the CSV. */
  sample: BootstrapDuplicateCopy[]
  decision: { policy: 'collapse'; fingerprint: string; decidedBy: string; decidedAt: string } | null
  /** Other data sources reading the same physical graph: collapsing changes it for them too.
   *  Named only within this workspace; those in other workspaces are only counted. */
  sharedWith: Array<{ dataSourceId: string; name: string }>
  sharedWithOtherWorkspaces: number
}

/** A row of the whole duplicate list: `copy` is its rank among its identifier's copies (1 = kept). */
export interface BootstrapDuplicateRow {
  urn: string
  copy: number
  kept: boolean
  label: string | null
  internalId: number
  lastSyncedAt: string | null
}

/** The server would not take a duplicates decision: the list changed since it was shown
 *  (`stale_decision` — review it again), or the job is no longer waiting for one
 *  (`not_awaiting_decision` — someone else decided, or it was restarted). */
export class BootstrapDecisionError extends Error {
  readonly type: 'stale_decision' | 'not_awaiting_decision'
  constructor(type: 'stale_decision' | 'not_awaiting_decision', message?: string) {
    super(message || (type === 'stale_decision'
      ? 'The list of duplicates changed — review it again.'
      : 'This copy is no longer waiting for a decision.'))
    this.name = 'BootstrapDecisionError'
    this.type = type
  }
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

/** A page (≤500 rows) of the whole duplicate list; pass `next` back as `after` (404 → none found). */
export function getBootstrapDuplicates(
  wsId: string, dataSourceId: string, opts: { after?: string | null; limit?: number } = {},
): Promise<{ items: BootstrapDuplicateRow[]; next: string | null }> {
  const q = new URLSearchParams({ dataSourceId })
  if (opts.after) q.set('after', opts.after)
  if (opts.limit) q.set('limit', String(opts.limit))
  return vfetch(`/api/v1/${wsId}/graph/bootstrap/duplicates?${q}`)
}

/** The whole duplicate list as a CSV download (the browser sends the session cookie). */
export function bootstrapDuplicatesCsvUrl(wsId: string, dataSourceId: string): string {
  return `/api/v1/${wsId}/graph/bootstrap/duplicates?${new URLSearchParams({ dataSourceId, format: 'csv' })}`
}

/** Collapse the duplicates and let the copy carry on. `fingerprint` is the list's as it was shown:
 *  if the source has changed since, the server refuses ({@link BootstrapDecisionError}) rather than
 *  apply the decision to a list nobody reviewed. Repeating a recorded decision is harmless. */
export function decideBootstrapDuplicates(
  wsId: string, dataSourceId: string, { fingerprint }: { fingerprint: string },
): Promise<BootstrapJob> {
  return vfetch<BootstrapJob>(
    `/api/v1/${wsId}/graph/bootstrap/decision?dataSourceId=${encodeURIComponent(dataSourceId)}`,
    jsonBody({ action: 'collapse', fingerprint }),
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
  /** `move` (node only): `payload = { parentEntityId | null, edgeType }` — the server replaces
   *  whatever parent link the node has; `ref` names the client's pending link. */
  op: 'create' | 'update' | 'delete' | 'move'
  kind: 'node' | 'edge'
  id?: string
  ref?: string
  payload?: Record<string, unknown> | null
  /** `update` only: property names to REMOVE. An update merges `payload.properties` key by key,
   *  so a property left out is kept — naming it here is the only way to delete one. */
  unsetProperties?: string[]
  /** Optimistic-concurrency token: the `version` (content hash) the entity was read at. On an
   *  update the server 3-way merges against it so a concurrent same-field edit conflicts instead
   *  of silently overwriting. Omit ⇒ plain patch (no OCC). */
  baseVersion?: string
}

export interface GraphChangesResult {
  commitId?: string | null
  assigned: Record<string, string>
  /** Every entity the save addressed, as it is now — refresh copies and tokens from these. */
  entities?: Record<string, EntityView>
  /** The save touched more entities than it answers for; re-read the rest. */
  entitiesTruncated?: boolean
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

/** One page of an entity's revisions, newest first: `main`'s and the viewed draft's own. */
export function getEntityHistoryPage(
  wsId: string,
  graphId: string,
  entityId: string,
  params: { branchId?: string | null; scope?: HistoryScope; limit?: number; before?: string | null; kind?: 'node' | 'edge' } = {},
): Promise<EntityHistoryResponse> {
  const sp = new URLSearchParams()
  if (params.branchId) sp.set('branchId', params.branchId)
  if (params.scope && params.scope !== 'all') sp.set('scope', params.scope)
  if (params.limit != null) sp.set('limit', String(params.limit))
  if (params.before) sp.set('before', params.before)
  if (params.kind) sp.set('kind', params.kind)
  const qs = sp.toString()
  return vfetch<EntityHistoryResponse>(
    `${base(wsId)}/graphs/${graphId}/entities/${encodeURIComponent(entityId)}/history${qs ? `?${qs}` : ''}`,
  )
}

/** Who created an entity and who last changed it, as the line being read has it. */
export function getEntitySummary(
  wsId: string,
  graphId: string,
  entityId: string,
  params: { branchId?: string | null; kind?: 'node' | 'edge'; includeValue?: boolean } = {},
): Promise<EntitySummary> {
  const sp = new URLSearchParams()
  if (params.branchId) sp.set('branchId', params.branchId)
  if (params.kind) sp.set('kind', params.kind)
  if (params.includeValue) sp.set('include', 'value')
  const qs = sp.toString()
  return vfetch<EntitySummary>(
    `${base(wsId)}/graphs/${graphId}/entities/${encodeURIComponent(entityId)}/summary${qs ? `?${qs}` : ''}`,
  )
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

/** A branch's changes between two seqs with whole-payload before/after — the renderable shape
 *  (`getDiff` is id-keyed: countable, not showable). Backs the "what came in" review after a pull:
 *  the window is main between the draft's old and new base. */
export function getDiffWindow(
  wsId: string,
  graphId: string,
  branchId: string,
  fromSeq: number,
  toSeq: number,
): Promise<DiffVsMainResponse> {
  return vfetch<DiffVsMainResponse>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/diff-window?fromSeq=${fromSeq}&toSeq=${toSeq}`,
  )
}

/** UI-shaped diff of a draft vs its base (whole payloads + before/after). */
/** `slim`: a modified entity by id and kind alone, without its before/after payloads — enough to
 *  count a draft's changes and ring its nodes, at any draft size. */
export function getDiffVsMain(
  wsId: string, graphId: string, branchId: string, { slim = false }: { slim?: boolean } = {},
): Promise<DiffVsMainResponse> {
  const q = slim ? '?payloads=changes' : ''
  return vfetch<DiffVsMainResponse>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/diff-vs-main${q}`)
}

// ============================================
// Hierarchical (containment-tree) diff — lazy, capped, business-friendly
// ============================================

/** What a draft changes in views, beside its graph changes. They go live when the draft does. */
export interface BranchViewChange {
  viewId: string
  workspaceId: string
  name: string
  /** `create`: a view that exists only in the draft (an import waiting to go live); `update`: an
   *  import staged for a view here; `layout`: layer edits made in the draft. */
  change: 'create' | 'update' | 'layout'
  origin: { environment?: string | null; version?: number | null; name?: string | null } | null
  matchRate: number | null
  stagedBy?: string | null
  stagedByName?: string | null
  stagedAt?: string | null
  /** create: its headline counts, and who it goes live for. */
  stats?: { layers?: number; assignments?: number }
  goesLiveAs?: 'private' | 'workspace'
  /** update / layout: what it changes. */
  diff?: ViewDefinitionDiff
}

export interface BranchViewChanges {
  branchId: string
  views: BranchViewChange[]
  /** Changes to views the caller can't read: counted, never shown. */
  hidden: number
}

export function getBranchViewChanges(wsId: string, graphId: string, branchId: string): Promise<BranchViewChanges> {
  return vfetch<BranchViewChanges>(`${base(wsId)}/graphs/${graphId}/branches/${branchId}/view-changes`)
}

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
export async function publishBranch(
  wsId: string,
  graphId: string,
  branchId: string,
  data: { message: string; resolutions?: ResolutionMap },
): Promise<CommitResponse> {
  return followPublish(wsId, await vfetch<CommitResponse | QueuedPublish>(
    `${base(wsId)}/graphs/${graphId}/branches/${branchId}/publish`, jsonBody(data)))
}

/** A draft too large to publish inside the request is published by a job (202): its id, and the
 *  graph whose publish jobs to ask about it. */
interface QueuedPublish {
  jobId: string
  graphId: string
}

interface PublishJob {
  jobId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  commitId: string | null
  /** The refusal a publish inside the request would have given. */
  error: { status: number; detail: RefusalDetail } | null
}

/** How long a queued publish may go unanswered before the publish gives up (tests shorten it). */
export const PUBLISH_JOB_POLL = { patienceMs: 120_000 }

/** The commit a publish (or review merge) made — at once, or once the job it queued is done. A
 *  refused job raises the error the request would have raised. Followed like every job
 *  (`pollJob`): a failed poll (a network blip, a web pod restarting) doesn't stop the job, so it is
 *  asked again until it goes unanswered too long. */
async function followPublish(wsId: string, answer: CommitResponse | QueuedPublish): Promise<CommitResponse> {
  if (!('jobId' in answer)) return answer
  const job = await pollJob(
    () => vfetch<PublishJob>(`${base(wsId)}/graphs/${answer.graphId}/publish-jobs/${answer.jobId}`),
    { patienceMs: PUBLISH_JOB_POLL.patienceMs },
  )
  if (job.status === 'completed' && job.commitId) return { commitId: job.commitId }
  throw versioningError(job.error?.status ?? 500, job.error?.detail, 'Publishing failed')
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

export async function mergeMergeRequest(
  wsId: string,
  prId: string,
  data: { message: string; resolutions?: ResolutionMap },
): Promise<CommitResponse> {
  return followPublish(wsId, await vfetch<CommitResponse | QueuedPublish>(
    `${base(wsId)}/merge-requests/${prId}/merge`, jsonBody(data)))
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
