/**
 * versionControlService — typed client for the authored-graph
 * version-control API (/api/v1/{wsId}/graphs/...).
 *
 * Wraps `authFetch`. The backend returns structured error bodies as
 * `{detail: {code, ...}}`; `authFetch` collapses an object detail with
 * no `message` to a JSON string in `Error.message`. So mutation calls
 * here re-parse that and raise *typed* errors the UI branches on:
 *   - RefMovedError       -> the "review & rebase" banner
 *   - GraphValidationError -> inline violation list
 *   - EmptyCommitError     -> "nothing to commit" toast
 */
import { authFetch } from './apiClient'

export interface GraphSummary {
  id: string
  workspace_id: string
  name: string
  description?: string | null
  origin: string
  schema_mode: string
  default_branch: string
  head_commit_id?: string | null
}

export interface CommitResult {
  commit_id: string
  commit_hash: string
  root_hash: string
  delta_summary: Record<string, number>
  branch: string
}

export interface CommitHistoryEntry {
  commit_id: string
  commit_hash: string
  parent_ids: string[]
  author?: string | null
  message?: string | null
  delta_summary: Record<string, number>
  committed_at: string
}

export interface Violation {
  code: string
  message: string
  object_kind: string
  object_id: string
}

export class RefMovedError extends Error {
  currentHead: string | null
  constructor(currentHead: string | null) {
    super('The branch moved — rebase required before committing.')
    this.name = 'RefMovedError'
    this.currentHead = currentHead
  }
}

export class GraphValidationError extends Error {
  violations: Violation[]
  constructor(violations: Violation[]) {
    super(`${violations.length} validation issue(s)`)
    this.name = 'GraphValidationError'
    this.violations = violations
  }
}

export class EmptyCommitError extends Error {
  constructor() {
    super('Nothing to commit.')
    this.name = 'EmptyCommitError'
  }
}

export interface StaleEntityViolation {
  object_kind: 'node' | 'edge'
  object_id: string
  expected_base_content_hash: string
  observed_content_hash: string | null
}

export class StaleEntityError extends Error {
  violations: StaleEntityViolation[]
  constructor(violations: StaleEntityViolation[]) {
    super(`${violations.length} stale entity edit(s) — rebase required`)
    this.name = 'StaleEntityError'
    this.violations = violations
  }
}

/** Strict graph references an ontology that does not exist (or is
 *  soft-deleted) in the management DB. */
export class OntologyMissingError extends Error {
  ontologyId: string | null
  constructor(ontologyId: string | null) {
    super('Bound ontology is missing or deleted.')
    this.name = 'OntologyMissingError'
    this.ontologyId = ontologyId
  }
}

/** Strict graph references an unpublished ontology — drafts cannot
 *  back authored graphs. */
export class OntologyNotPublishedError extends Error {
  ontologyId: string | null
  constructor(ontologyId: string | null) {
    super('Bound ontology is not published.')
    this.name = 'OntologyNotPublishedError'
    this.ontologyId = ontologyId
  }
}

/** Strict graph create attempted without an ontology_id. */
export class OntologyRequiredError extends Error {
  constructor() {
    super('Strict schema mode requires an ontology.')
    this.name = 'OntologyRequiredError'
  }
}

/** Best-effort parse of a structured detail out of an Error thrown by
 * authFetch (it may be a JSON string of the detail object, the
 * `.message` of a structured detail, or a plain string). */
export function parseDetail(err: unknown): any | null {
  if (!(err instanceof Error)) return null
  const msg = err.message
  try {
    const parsed = JSON.parse(msg)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function rethrowTyped(err: unknown): never {
  const d = parseDetail(err)
  if (d) {
    if (d.code === 'ref_moved') throw new RefMovedError(d.current_head ?? null)
    if (d.code === 'empty_commit') throw new EmptyCommitError()
    if (d.code === 'stale_entity' && Array.isArray(d.violations)) {
      throw new StaleEntityError(d.violations as StaleEntityViolation[])
    }
    if (d.code === 'validation' && Array.isArray(d.violations)) {
      throw new GraphValidationError(d.violations as Violation[])
    }
    if (d.code === 'ontology_required') throw new OntologyRequiredError()
    if (d.code === 'ontology_missing') {
      throw new OntologyMissingError(d.ontology_id ?? null)
    }
    if (d.code === 'ontology_not_published') {
      throw new OntologyNotPublishedError(d.ontology_id ?? null)
    }
  }
  throw err instanceof Error ? err : new Error(String(err))
}

const base = (ws: string) => `/api/v1/${encodeURIComponent(ws)}/graphs`

/** Stable id of the seeded "Basic Lineage" system ontology — the
 *  Simple Lineage on-ramp picks this without showing a picker. Kept
 *  in lock-step with `seeded_ontologies.BASIC_LINEAGE_ONTOLOGY_ID`
 *  on the backend. */
export const BASIC_LINEAGE_ONTOLOGY_ID = 'bp_basic_lineage'

export interface CreateGraphRequest {
  name: string
  description?: string
  schema_mode?: 'schemaless' | 'strict'
  ontology_id?: string | null
  origin?: 'authored' | 'connected'
  source_data_source_id?: string | null
}

export async function createGraph(
  wsId: string,
  body: CreateGraphRequest,
): Promise<GraphSummary> {
  try {
    return await authFetch<GraphSummary>(`${base(wsId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    rethrowTyped(err)
  }
}

export async function listGraphs(wsId: string): Promise<GraphSummary[]> {
  return authFetch<GraphSummary[]>(`${base(wsId)}`)
}

export async function getGraph(wsId: string, graphId: string): Promise<GraphSummary> {
  return authFetch<GraphSummary>(`${base(wsId)}/${graphId}`)
}

export interface StagedChangeInput {
  change_type:
    | 'add_node' | 'update_node' | 'delete_node'
    | 'add_edge' | 'update_edge' | 'delete_edge'
  object_kind: 'node' | 'edge'
  object_id: string
  payload: Record<string, unknown>
  summary?: string
}

export async function stageChanges(
  wsId: string,
  graphId: string,
  branch: string,
  changes: StagedChangeInput[],
): Promise<{ ws_change_version: number }> {
  return authFetch(`${base(wsId)}/${graphId}/branches/${encodeURIComponent(branch)}/stage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  })
}

export async function getWorkingSet(
  wsId: string,
  graphId: string,
  branch: string,
): Promise<{
  base_commit_id: string | null
  ws_change_version: number
  changes: Array<{
    change_type: string; object_kind: string; object_id: string
    summary: string; after: Record<string, unknown> | null
  }>
}> {
  return authFetch(`${base(wsId)}/${graphId}/branches/${encodeURIComponent(branch)}/working-set`)
}

export async function commit(
  wsId: string,
  graphId: string,
  branch: string,
  message: string,
  expectedHeadCommitId: string | null,
): Promise<CommitResult> {
  try {
    return await authFetch<CommitResult>(
      `${base(wsId)}/${graphId}/branches/${encodeURIComponent(branch)}/commits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          expected_head_commit_id: expectedHeadCommitId,
        }),
      },
    )
  } catch (err) {
    rethrowTyped(err)
  }
}

export async function history(
  wsId: string,
  graphId: string,
  branch: string,
  limit = 50,
): Promise<CommitHistoryEntry[]> {
  return authFetch<CommitHistoryEntry[]>(
    `${base(wsId)}/${graphId}/branches/${encodeURIComponent(branch)}/commits?limit=${limit}`,
  )
}

/**
 * V1-6 functional pull: re-anchor the caller's working set against
 * the current branch HEAD.
 *
 * Returns `rebased` (staged ops that re-anchor cleanly), `dropped`
 * (delete/delete coincidences removed automatically), and
 * `conflicts` (per-entity conflicts the user must resolve). On
 * conflict the staged op stays in the working set with its original
 * `base_content_hash` so the conflict resolver can show ours/theirs
 * and let the user pick a resolution without losing work.
 */
export interface PullConflict {
  object_kind: 'node' | 'edge'
  object_id: string
  conflict_class: 'edit_edit' | 'edit_delete' | 'delete_edit' | 'add_add'
  base_content_hash: string | null
  current_content_hash: string | null
  staged_change_type: string
}

export interface PullResult {
  previous_base: string | null
  new_base: string | null
  rebased: number
  dropped: number
  conflicts: PullConflict[]
}

export async function pullWorkingSet(
  wsId: string,
  graphId: string,
  branch: string,
): Promise<PullResult> {
  return authFetch<PullResult>(
    `${base(wsId)}/${graphId}/branches/${encodeURIComponent(branch)}/working-set/pull`,
    { method: 'POST' },
  )
}

export async function createBranch(
  wsId: string,
  graphId: string,
  name: string,
  fromCommitId: string | null,
): Promise<{ branch: string; commit_id: string | null }> {
  return authFetch(`${base(wsId)}/${graphId}/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, from_commit_id: fromCommitId }),
  })
}

// ── SSE: live branch events ──────────────────────────────────────────

export interface BranchCommitEvent {
  commit_id: string
  commit_hash: string
  root_hash: string | null
  actor: string | null
  delta_summary: Record<string, number>
}

export interface WorkingSetAdvancedEvent {
  ws_change_version: number
}

export interface BranchEventHandlers {
  onCommit?: (e: BranchCommitEvent) => void
  /** Same-user signal: another of this user's tabs staged on this
   * branch. Filtered server-side by user_id. */
  onWorkingSetAdvanced?: (e: WorkingSetAdvancedEvent) => void
  onOpen?: () => void
  onError?: (err: Event) => void
}

export interface SSESubscription {
  /** Closes the underlying EventSource. Idempotent. */
  close: () => void
}

export function branchEventsUrl(
  wsId: string,
  graphId: string,
  branch: string,
): string {
  return `${base(wsId)}/${graphId}/branches/${encodeURIComponent(branch)}/events`
}

/** Subscribe to live SSE events for `(graph, branch)`.
 *
 * Returns an object with `.close()`; the browser's `EventSource` handles
 * auto-reconnect with `Last-Event-ID` so the caller does not need to
 * manage retries. `withCredentials: true` so the auth cookie travels.
 *
 * Phase 1 ships the `commit` event only; `working_set_advanced` arrives
 * with the same shape when item 4 lands. */
export function subscribeBranchEvents(
  wsId: string,
  graphId: string,
  branch: string,
  handlers: BranchEventHandlers,
): SSESubscription {
  const url = branchEventsUrl(wsId, graphId, branch)
  const es = new EventSource(url, { withCredentials: true })

  if (handlers.onOpen) {
    es.addEventListener('open', () => handlers.onOpen!())
  }
  if (handlers.onError) {
    es.addEventListener('error', (ev) => handlers.onError!(ev))
  }
  if (handlers.onCommit) {
    es.addEventListener('commit', (ev) => {
      const msg = ev as MessageEvent
      try {
        handlers.onCommit!(JSON.parse(msg.data) as BranchCommitEvent)
      } catch {
        // Malformed payload — drop; the server contract is JSON.
      }
    })
  }
  if (handlers.onWorkingSetAdvanced) {
    es.addEventListener('working_set_advanced', (ev) => {
      const msg = ev as MessageEvent
      try {
        handlers.onWorkingSetAdvanced!(
          JSON.parse(msg.data) as WorkingSetAdvancedEvent,
        )
      } catch {
        // Malformed payload — drop.
      }
    })
  }

  return { close: () => es.close() }
}
