/**
 * saveStagedChangesToDraft — the draft "Save" path, as ONE atomic commit.
 *
 * Every staged edit — creates (the backend mints the urn + resolves temp refs), user-drawn and
 * containment edges, renames/updates/deletes, AND layer moves — is translated to `/graph/changes`
 * ops and sent in a SINGLE batch, so one Review & Save lands as exactly one commit on the draft
 * (not one commit per created entity). The commit is atomic: on any failure nothing is persisted.
 *
 * After the commit succeeds there is NO reload — the canvas keeps its optimistic nodes — so we
 * reconcile it in place from the batch's ref→id map, in one pass: each create's temp node becomes
 * the real one (childCount-safe), user-drawn edges are re-pointed at the real endpoints, and layer
 * assignments are re-keyed temp→real.
 */
import {
  applyGraphChanges, BranchClosedError, DraftRoleRequiredError, GraphNotWritableError, IntegrityError,
  MainWriteForbiddenError, MergeConflictError, NotDraftOwnerError, OntologyViolationError,
  type EntityView, type GraphChangeOp, type GraphChangesResult,
} from '@/services/versioningApiService'
import { newRequestId } from '@/services/viewTransferApiService'
import type { GraphDataProvider, GraphEdge, GraphNode } from '@/providers/GraphDataProvider'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { markSnapshotCommitting, type PendingSave } from '@/features/canvas-drafts/stagedDraftPersistence'
import { stagedChangesToOps, unsavedNodeFields } from './stagedChangesToOps'

export interface DraftSaveTarget {
  wsId: string
  dataSourceId: string
  branchId: string
  provider: GraphDataProvider
  message?: string
  /**
   * Re-key what the canvas keeps by entity id outside the graph — view-config (layer) assignments,
   * open nodes — from every created entity's temp urn onto its real urn (`ids`: temp → real), so a
   * node created in a layer keeps its column after the save reconciles. Called ONCE per save with
   * the whole map: this is the save's one layout write, so it also prunes what `pruneTempAssignments`
   * would.
   */
  remapEntityIds?: (ids: ReadonlyMap<string, string>) => void
  /**
   * Prune any view-config assignment entries STILL keyed by a temp urn — a discarded create leaves
   * an inert temp-urn placement behind. Called instead of `remapEntityIds` by a save that created
   * nothing.
   */
  pruneTempAssignments?: () => void
}

/** A save that may have reached the server, per draft (the staged store's scope key): a retry of the
 *  very same batch reuses its key, so the server answers with what that save did instead of applying
 *  it twice. Any other batch on that draft first sends this one again, exactly, under its key (see
 *  `settle`). It is never sent on, or carried into the snapshot of, any other draft. */
const pendingSaves = new Map<string | null, PendingSave>()

/** The save on this draft that may have reached the server, for its staged-draft snapshot to carry over a reload. */
export function getPendingSave(scope: string | null): PendingSave | null {
  return pendingSaves.get(scope) ?? null
}

/** After a reload, take back the save the draft's snapshot carried, so it is settled before anything else. */
export function resumePendingSave(save: PendingSave, scope: string | null): void {
  pendingSaves.set(scope, save)
}

/** The draft's staged edits are gone (saved, discarded or copied away): there is nothing left to settle. */
export function clearPendingSave(scope: string | null): void {
  pendingSaves.delete(scope)
}

/** The server answered and applied nothing: a save is all or nothing. Any other 4xx is an answer
 *  too; only a lost answer, a timeout (408), a throttle (429) or a server error may have applied it. */
const refused = (e: unknown) => {
  const status = (e as { status?: unknown } | null)?.status
  return [MergeConflictError, IntegrityError, OntologyViolationError, BranchClosedError, NotDraftOwnerError,
    DraftRoleRequiredError, MainWriteForbiddenError, GraphNotWritableError].some((cls) => e instanceof cls)
    || (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429)
}

/** Send a save that may have reached the server again, exactly as it went, under its key: the server
 *  answers with what it did if it committed, and applies it if it never arrived — never twice. A
 *  refusal means it was not applied, so there is nothing to settle; any other failure keeps the key. */
async function settle(save: PendingSave, scope: string | null): Promise<{ res: GraphChangesResult; sent: Record<string, string> } | null> {
  const [wsId, dsId, branchId, ops, message] = JSON.parse(save.body) as [string, string, string, GraphChangeOp[], string | null]
  try {
    const res = await applyGraphChanges(wsId, dsId, branchId, ops, message ?? undefined, save.key)
    pendingSaves.delete(scope)
    return { res, sent: save.sent ?? {} }
  } catch (e) {
    if (!refused(e)) throw e
    pendingSaves.delete(scope)
    return null
  }
}

/** A change the settled save carried and the user edited since, re-based onto what that save stored:
 *  it now edits the entity that save left, from the value it sent, at the token the server returned —
 *  so a create is never sent twice, and the edit does not conflict with the user's own save. */
function rebase(c: StagedChange, sentAfter: unknown, res: GraphChangesResult): StagedChange {
  if (c.type === 'move_entity') return c   // the server moves the node from wherever it is now
  const created = c.type === 'create_entity' ? res.assigned?.[c.targetUrn ?? c.targetId] : undefined
  const key = created ?? c.targetUrn ?? c.targetId
  // `entities` answers for at most 500; `versions` holds every written entity's token.
  const version = res.entities?.[key]?.version ?? res.versions?.[key] ?? undefined
  const before = { ...(c.before as object), ...(sentAfter as object), version }
  return created
    ? { ...c, type: 'update_entity', targetId: created, targetUrn: created, before, discard: undefined }
    : { ...c, before }
}

export async function saveStagedChangesToDraft(
  changes: StagedChange[],
  target: DraftSaveTarget,
): Promise<{ commitId?: string | null; unsaved: string[] }> {
  // Node fields the op mapper cannot carry (see `unsavedNodeFields`). Returned rather than
  // dropped: an edit made only of these produces ZERO ops, and a zero-op save resolves exactly
  // like a commit — which is how a green "Saved to draft." came to stand over a save that never
  // left the browser. The caller says what actually happened.
  const unsaved = [...new Set(changes.flatMap(unsavedNodeFields))].sort()
  // ── Build ONE op batch ──────────────────────────────────────────────────────────────────────
  // Layer placement (assign_layer / move_to_layer / reorder_nodes) is VIEW config, not graph data — it produces
  // ZERO graph ops. It persists to the view's referenceLayout.assignments via persistReferenceLayout;
  // on save, `remapEntityIds` re-keys a created entity's assignment temp→real (see the canvas caller).
  const bodyOf = (batch: GraphChangeOp[]) =>
    JSON.stringify([target.wsId, target.dataSourceId, target.branchId, batch, target.message])
  let ops: GraphChangeOp[] = stagedChangesToOps(changes)   // creates + edges + renames/updates/deletes

  if (ops.length === 0) {
    // No graph ops (e.g. a layer-only save), but a discarded create may still have left an inert
    // temp-urn placement in the view config — prune it so it doesn't accumulate.
    target.pruneTempAssignments?.()
    return { commitId: null, unsaved }
  }

  // ── An earlier save that may have committed (no answer came back, or a reload cut it off) ────
  // Unless this is that very batch again, it is settled first, exactly, under its key — so a
  // committed create is never sent a second time under a new key. Only the changes it did not carry,
  // or that were edited since it went out, go next, their references to what it created resolved to
  // the real ids. A save that does not say what it carried (an older snapshot) is only resent as is.
  const scope = useStagedChangesStore.getState()._scopeKey
  const pending = pendingSaves.get(scope)
  const settled = pending?.sent && pending.body !== bodyOf(ops) ? await settle(pending, scope) : null
  let rest = changes
  const edited = new Map<string, StagedChange>()
  if (settled) {
    const resolve = (id: string) => settled.res.assigned?.[id] ?? id
    for (const c of changes) {
      const sent = settled.sent[c.id]
      if (sent !== undefined && sent !== JSON.stringify(c.after ?? null)) edited.set(c.id, rebase(c, JSON.parse(sent), settled.res))
    }
    // Staged as re-based, so a later save sends the edit even if this one fails.
    if (edited.size > 0) {
      useStagedChangesStore.setState((s) => ({ changes: s.changes.map((c) => edited.get(c.id) ?? c) }))
    }
    rest = changes.flatMap((c) => edited.get(c.id) ?? (settled.sent[c.id] !== undefined ? [] : [c]))
    ops = stagedChangesToOps(rest, resolve).map((op) => (op.id ? { ...op, id: resolve(op.id) } : op))
  }

  // ── One atomic commit ───────────────────────────────────────────────────────────────────────
  // On any failure NOTHING is persisted (no partial state). The error propagates to the caller,
  // which surfaces it; the staged changes stay put for a clean retry.
  let res: GraphChangesResult = settled?.res ?? { assigned: {} }
  if (ops.length > 0) {
    const body = bodyOf(ops)
    const prior = pendingSaves.get(scope)
    const key = prior?.body === body ? prior.key : newRequestId()
    const save: PendingSave = { body, key, sent: Object.fromEntries(rest.map((c) => [c.id, JSON.stringify(c.after ?? null)])) }
    pendingSaves.set(scope, save)
    // The key rides in the crash snapshot before the request leaves, so a reload mid-save keeps it.
    if (scope) markSnapshotCommitting(scope, save)
    let next: GraphChangesResult
    try {
      next = await applyGraphChanges(target.wsId, target.dataSourceId, target.branchId, ops, target.message, key)
    } catch (e) {
      // Refused: not applied, so never resent later — the next save sends the edits as they are then.
      if (refused(e)) pendingSaves.delete(scope)
      // The settled save did commit: what it carried, unchanged since, leaves the staged list, so no
      // later save resends it. An edit made since stays staged (re-based), and on the canvas as made.
      if (settled) {
        const carried = changes.filter((c) => settled.sent[c.id] !== undefined)
        const stillEdited = new Set([...edited.values()].map((c) => c.targetUrn ?? c.targetId))
        const notEdited = <T>(byId: Record<string, T> | undefined) =>
          Object.fromEntries(Object.entries(byId ?? {}).filter(([id]) => !stillEdited.has(id)))
        reconcileSaved(carried, {
          ...settled.res, entities: notEdited(settled.res.entities), versions: notEdited(settled.res.versions),
        }, target)
        useStagedChangesStore.getState().clearSaved(carried.filter((c) => !edited.has(c.id)).map((c) => c.id))
      }
      throw e
    }
    pendingSaves.delete(scope)
    res = {
      ...next,
      assigned: { ...res.assigned, ...next.assigned },
      entities: { ...res.entities, ...next.entities },
      versions: { ...res.versions, ...next.versions },
    }
  }
  reconcileSaved(changes, res, target)
  return { commitId: res.commitId ?? null, unsaved }
}

/** The optimistic canvas, reconciled in place with what a save stored (there is no post-save
 *  reload) — in ONE pass, however many entities the save created: the temp→real map is built once,
 *  and the canvas, the layout and the open nodes are each re-keyed by it in a single write. (Swapped
 *  node by node, every swap rescanned and rewrote the whole canvas and the view's layout: O(n²) on a
 *  large paste.) */
function reconcileSaved(changes: StagedChange[], res: GraphChangesResult, target: DraftSaveTarget): void {
  const assigned = res.assigned ?? {}
  const resolveRef = (id: string) => assigned[id] ?? id

  // Cosmetic canvas surgery — a glitch here must never fail an already-committed save.
  try { rekeyCanvas(changes, resolveRef) } catch { /* noop */ }

  // Placements (and open nodes) keyed by a created entity's temp urn move to its real one, in the
  // save's one layout write — which also prunes a temp urn's placement left by a create discarded
  // before this save (see the canvas caller). A save that created nothing only prunes.
  const realIds = new Map<string, string>()
  for (const c of changes) {
    const tempUrn = c.targetUrn
    if (tempUrn && resolveRef(tempUrn) !== tempUrn) realIds.set(tempUrn, resolveRef(tempUrn))
  }
  if (realIds.size > 0 && target.remapEntityIds) target.remapEntityIds(realIds)
  else target.pruneTempAssignments?.()

  // Replace the canvas's copies with what was stored — values AND tokens. Without this the next
  // edit of an entity just saved three-way-merged against the value it was READ at, and
  // conflicted with the user's own save. `entities` answers for at most 500 of them; `versions`
  // gives the token of every entity written.
  applyServerEntities(res.entities)
  if (res.versions) useCanvasStore.getState().applyServerVersions(res.versions)
}

/** Each create's optimistic temp node becomes the real one, generic over how it was staged (single
 *  add via useStageEntityCreation, build/paste via planBuildStaging: the same shape on `c.after`).
 *  Its childCount counts the children staged under it — or the first collapse after the save drops
 *  their (now saved) links, and the expand that follows never asks for them again — and its
 *  containment link is rebuilt with the ONTOLOGY-resolved type the change carries (never a
 *  fabricated default: no type ⇒ no edge, as stagedChangesToOps sent). Every user-drawn link — a
 *  drawn or reversed one, or a move's new parent link (its pending id rode as the op's `ref`) —
 *  takes its real id and ends; any other edge on a created node is dropped (a created child rebuilds
 *  its own link). One store write. */
function rekeyCanvas(changes: StagedChange[], resolveRef: (id: string) => string): void {
  const created = new Map<string, StagedChange>()   // temp urn → its create
  const links = new Set<string>()                   // the user-drawn links' pending ids
  for (const c of changes) {
    if (c.type === 'create_entity') created.set(c.targetUrn ?? c.targetId, c)
    const pendingId = c.type === 'create_edge' || c.type === 'reverse_edge' ? c.targetId
      : c.type === 'move_entity' ? (c.after as { edgeId?: string | null }).edgeId : null
    if (pendingId) links.add(pendingId)
  }
  if (created.size === 0 && links.size === 0) return
  const cs = useCanvasStore.getState()

  const stagedChildren = new Map<string, number>()
  for (const e of cs.edges) {
    if (e.type === 'containment' && e.data?.isPending === 'create' && created.has(e.source)) {
      stagedChildren.set(e.source, (stagedChildren.get(e.source) ?? 0) + 1)
    }
  }
  const nodes = cs.nodes.map((n) => {
    if (!created.has(n.id)) return n
    const id = resolveRef(n.id)
    return { ...n, id, data: {
      ...n.data, urn: id, isPending: undefined,
      childCount: Math.max((n.data?.childCount as number) ?? 0, stagedChildren.get(n.id) ?? 0),
    } }
  })

  // First one wins on an id: the edges kept, then the rebuilt containment, then the user's links.
  const edges: LineageEdge[] = []
  const seen = new Set<string>()
  const add = (e: LineageEdge) => { if (!seen.has(e.id)) { seen.add(e.id); edges.push(e) } }
  for (const e of cs.edges) {
    if (!links.has(e.id) && !created.has(e.source) && !created.has(e.target)) add(e)
  }
  for (const [tempUrn, c] of created) {
    const after = (c.after ?? {}) as { parentUrn?: string; containmentEdgeType?: string }
    if (!after.parentUrn || !after.containmentEdgeType) continue
    const et = after.containmentEdgeType
    add({
      id: resolveRef(`contains-${tempUrn}`), source: resolveRef(after.parentUrn), target: resolveRef(tempUrn),
      type: 'containment', data: { edgeType: et, relationship: et.toLowerCase() },
    })
  }
  for (const e of cs.edges) {
    if (!links.has(e.id)) continue
    add({ ...e, id: resolveRef(e.id), source: resolveRef(e.source), target: resolveRef(e.target),
      data: { ...e.data, isPending: undefined } })
  }
  cs.setNodesAndEdges(nodes, edges)
}

/** The save's answer (`entities`: each addressed entity as it is now) onto the canvas. */
export function applyServerEntities(entities: Record<string, EntityView> | undefined): void {
  if (!entities) return
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  for (const view of Object.values(entities)) {
    if (view.deleted) continue
    if (view.kind === 'node') nodes.push(view.node)
    else edges.push(view.edge)
  }
  const cs = useCanvasStore.getState()
  cs.applyServerNodes(nodes)
  cs.applyServerEdges(edges)
}
