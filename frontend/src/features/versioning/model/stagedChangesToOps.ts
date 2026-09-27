/**
 * stagedChangesToOps — translate the canvas's staged edits into atomic `/graph/changes`
 * ops for a draft save. Handles entity mutations (rename/update/delete a node,
 * edit/delete/reverse an edge) plus user-drawn raw edges (`create_edge`);
 * `create_entity` is intentionally excluded — it
 * keeps going through the proven `provider.createNode` path (which constructs the urn and
 * the containment edge), and is run first by `saveStagedChangesToDraft`.
 *
 * Updates are *partial* (the backend merges onto current state), so we only emit the
 * fields that changed — normalized from the canvas display shape (`label`/`type`) to the
 * backend `GraphNode` shape (`displayName`/`entityType`) — and name each removed property in
 * `unsetProperties`. No op ever carries a removal marker inside its payload.
 */
import type { GraphChangeOp } from '@/services/versioningApiService'
import type { StagedChange } from '@/store/stagedChangesStore'
import { EDITABLE_NODE_FIELDS, toPayloadShape, type NodePayloadShape } from '@/lib/nodeFields'

// Client-only / immutable edge keys that must never reach the backend (mirrors EdgeDetailPanel).
const IMMUTABLE_EDGE_KEYS = new Set([
  'edgeType', 'relationship', 'isAggregated', 'sourceEdgeCount', 'sourceEdges', 'animated',
])

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** A property-bag edit as the wire carries it: the keys it set (changed or added) and the keys it
 *  removed. An update merges `properties` key by key, so a key left out is KEPT — a removal has to
 *  be named (`unsetProperties`), and nothing else is sent for the keys that did not change. */
export function propertiesPatch(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { set: Record<string, unknown>; unset: string[] } {
  const set: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before) || !same(before[k], v)) set[k] = v
  }
  const unset = Object.keys(before).filter((k) => !(k in after))
  return { set, unset }
}

/** The OCC token (`version` content-hash) the entity was read at, for optimistic concurrency.
 * Looks on the staged `before` (node/edge as read) or its nested `edge`. Absent ⇒ the backend
 * falls back to a plain patch (no OCC) — so this is safe even before hydration carries `version`. */
function versionOf(before: unknown): string | undefined {
  const b = asObj(before)
  const v = b.version ?? asObj(b.edge).version ?? asObj(b.node).version
  return typeof v === 'string' ? v : undefined
}

/** Empty in every spelling a form produces — so an untouched blank field is not an edit. */
const blank = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** A node's properties in the backend's shape, with the business label folded in when the data
 *  carries only the canvas mirror (`data.businessLabel`, a partial snapshot) — the label IS a
 *  user property; nothing on the backend stores a top-level one. */
function payloadShape(data: unknown): NodePayloadShape {
  const d = asObj(data)
  const shape = toPayloadShape(d)
  if (!('properties' in d) && typeof d.businessLabel === 'string' && d.businessLabel.trim()) {
    shape.properties = { businessLabel: d.businessLabel }
  }
  return shape
}

/**
 * A node update as the wire carries it: the stored top-level fields that changed, the user
 * properties that were set, and the ones removed. Reserved names the reader mirrors into
 * `properties` (e.g. `childCount`) are never compared, sent or removed.
 */
export function nodeUpdatePatch(before: unknown, after: unknown): { payload: Record<string, unknown>; unset: string[] } {
  const b = payloadShape(before)
  const a = payloadShape(after)
  const payload: Record<string, unknown> = {}
  for (const field of EDITABLE_NODE_FIELDS) {
    if (!(field in a)) continue
    if (blank(a[field]) && blank(b[field])) continue
    if (!same(a[field], b[field])) payload[field] = a[field]
  }
  let unset: string[] = []
  if (a.properties) {
    const patch = propertiesPatch(b.properties ?? {}, a.properties)
    if (Object.keys(patch.set).length > 0) payload.properties = patch.set
    unset = patch.unset
  }
  return { payload, unset }
}

/** The `after` keys the node patch reads AND the backend stores. A node field the user changed
 *  that is NOT here never lands — see `unsavedNodeFields`. `businessLabel` is the canvas mirror of
 *  `properties.businessLabel` and is carried through the bag (see `payloadShape`). */
const MAPPED_NODE_KEYS = new Set([
  'displayName', 'label', 'entityType', 'type', 'tags', 'classifications',
  'description', 'qualifiedName', 'sourceSystem', 'properties',
])

/** Backend-managed or client-only node fields: deliberately never sent, and never a loss.
 *  `layerAssignment` is VIEW config (referenceLayout.assignments); the rest are read-only. */
const UNSENT_NODE_KEYS = new Set(['urn', 'version', 'childCount', 'lastSyncedAt', 'layerAssignment'])

/** The node fields a staged entity edit CHANGED that the node patch cannot carry — an edit the
 *  backend will never see. Empty for every other change type. The save path reports these rather
 *  than letting a green "saved" stand over an edit that never left the browser: an update whose
 *  whole patch is empty is skipped below, and one that maps only in part still commits. */
export function unsavedNodeFields(c: StagedChange): string[] {
  if (c.type !== 'update_entity' && c.type !== 'rename_entity') return []
  const before = asObj(c.before)
  const after = asObj(c.after)
  // The label mirror is carried when the bag it mirrors says the same thing.
  const labelCarried = (payloadShape(after).properties?.businessLabel ?? '') === (after.businessLabel ?? '')
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => !MAPPED_NODE_KEYS.has(k) && !UNSENT_NODE_KEYS.has(k))
    .filter((k) => !(k === 'businessLabel' && labelCarried))
    .filter((k) => !same(before[k], after[k]))
    .sort()
}

export function stagedChangesToOps(
  changes: StagedChange[],
  // Rewrites a staged endpoint id to its real id. After Phase 1 creates the new
  // nodes, an edge drawn between two brand-new nodes still references their temp
  // urns — resolve them here so the backend sees live endpoints (entity_id == urn
  // in the versioned graph), otherwise the edge would dangle on apply.
  resolveId: (id: string) => string = (id) => id,
): GraphChangeOp[] {
  const ops: GraphChangeOp[] = []
  for (const c of changes) {
    switch (c.type) {
      case 'rename_entity':
      case 'update_entity': {
        // Only what changed since the node was read: a field sent unchanged would copy the value
        // read into the draft over a later one, and a property left out is kept, never removed.
        const { payload, unset } = nodeUpdatePatch(c.before, c.after)
        // An empty patch is a no-op, so it is not sent — but it is never silently dropped:
        // `unsavedNodeFields` names exactly what this skipped, and the save reports it.
        if (Object.keys(payload).length > 0 || unset.length > 0) {
          ops.push({ op: 'update', kind: 'node', id: c.targetUrn ?? c.targetId, payload,
                     ...(unset.length > 0 ? { unsetProperties: unset } : {}),
                     baseVersion: versionOf(c.before) })
        }
        break
      }
      case 'delete_entity':
        ops.push({ op: 'delete', kind: 'node', id: c.targetUrn ?? c.targetId })
        break
      case 'edit_edge': {
        const after = asObj(c.after)
        const payload: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(after)) {
          if (!IMMUTABLE_EDGE_KEYS.has(k) && k !== 'properties') payload[k] = v
        }
        // An edited property bag goes as a DIFF against what was read: the backend merges
        // `properties` key by key, so resending the whole bag would copy main's later values into
        // the draft, and a key left out is kept — a removal is named in `unsetProperties`.
        let unset: string[] = []
        if ('properties' in after) {
          const patch = propertiesPatch(asObj(asObj(c.before).properties), asObj(after.properties))
          if (Object.keys(patch.set).length > 0) payload.properties = patch.set
          unset = patch.unset
        }
        if (Object.keys(payload).length > 0 || unset.length > 0) {
          ops.push({ op: 'update', kind: 'edge', id: c.targetId, payload,
                     ...(unset.length > 0 ? { unsetProperties: unset } : {}),
                     baseVersion: versionOf(c.before) })
        }
        break
      }
      case 'delete_edge':
        ops.push({ op: 'delete', kind: 'edge', id: c.targetId })
        break
      case 'create_edge': {
        // A user-drawn RAW edge. Endpoints are canvas node ids (== urns == backend
        // entity_ids); resolve any temp endpoints to their created-node ids.
        const after = asObj(c.after)
        const data = asObj(after.data)
        const src = after.source ?? after.sourceEntityId
        const tgt = after.target ?? after.targetEntityId
        ops.push({
          op: 'create',
          kind: 'edge',
          ref: c.targetId,
          payload: {
            edgeType: after.edgeType ?? data.edgeType,
            sourceEntityId: src != null ? resolveId(String(src)) : src,
            targetEntityId: tgt != null ? resolveId(String(tgt)) : tgt,
          },
        })
        break
      }
      case 'reverse_edge': {
        // Endpoints aren't mutable in place — drop the original and recreate it flipped.
        const before = asObj(asObj(c.before).edge)
        const after = asObj(asObj(c.after).edge)
        if (before.id) ops.push({ op: 'delete', kind: 'edge', id: String(before.id) })
        ops.push({
          op: 'create',
          kind: 'edge',
          id: c.targetId,
          payload: {
            edgeType: after.edgeType ?? asObj(after.data).edgeType,
            sourceEntityId: after.source != null ? resolveId(String(after.source)) : after.source,
            targetEntityId: after.target != null ? resolveId(String(after.target)) : after.target,
          },
        })
        break
      }
      case 'create_entity': {
        // The collapsed save sends creates in the SAME atomic batch as everything else. The node
        // carries NO urn — the backend mints it (entity_id == urn), exactly like /nodes/create — and
        // is referenced by its temp urn (`ref`) so a nested child's containment edge (or a user-drawn
        // edge) can point at it within the one commit. The parent is passed by ref too (a staged temp
        // urn OR an existing real urn); the backend resolves it in the same batch.
        const after = asObj(c.after)
        const ref = c.targetUrn ?? c.targetId
        // The node payload is EVERY field on `after` except the client-only containment hints (parent
        // linkage is expressed via the containment edge below, never stored on the node). No per-field
        // allow-list to drift: a fresh create carries just the basics it set; a Restore replays the
        // deleted entity's ENTIRE snapshot, so nothing is dropped. An explicit `urn` ⇒ resurrect that
        // entity (create-over-tombstone) instead of minting a new one.
        const CONTAINMENT_HINT_FIELDS = new Set(['parentUrn', 'containmentEdgeType', 'parentLabel'])
        const payload: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(after)) {
          if (v !== undefined && !CONTAINMENT_HINT_FIELDS.has(k)) payload[k] = v
        }
        ops.push({ op: 'create', kind: 'node', ref, payload })
        // Containment edge to the parent. The edge TYPE is whatever the ONTOLOGY resolved at staging
        // (carried on `after.containmentEdgeType` — see `containmentEdgeTypeFor` / `useContainmentEdgeTypes`),
        // never a fabricated default. If the ontology defines no containment relationship for this
        // pairing there is no type, so no edge is emitted — the node is created at the root and the
        // commit-boundary ontology gate stays authoritative on whether that placement is valid.
        if (after.parentUrn != null && after.containmentEdgeType) {
          ops.push({
            op: 'create',
            kind: 'edge',
            ref: `contains-${ref}`,
            payload: {
              edgeType: after.containmentEdgeType,
              sourceEntityId: resolveId(String(after.parentUrn)),
              targetEntityId: ref,
            },
          })
        }
        break
      }
      case 'move_entity': {
        // ONE server-resolved move: the backend removes whatever parent link the node has (loaded on
        // this canvas or not) and adds the new one, under the same ontology/integrity gate. The
        // pending link's temp id rides as `ref`, so the save echoes its real id back.
        const m = asObj(c.after)
        ops.push({
          op: 'move',
          kind: 'node',
          id: resolveId(String(m.childId)),
          ref: m.edgeId != null ? String(m.edgeId) : undefined,
          payload: {
            parentEntityId: m.parentId != null ? resolveId(String(m.parentId)) : null,
            edgeType: m.edgeType ?? null,
          },
        })
        break
      }
      // assign_layer / move_to_layer / layer_config / reorder_nodes → VIEW config, not graph data.
      // They persist to referenceLayout via persistReferenceLayout and produce ZERO graph ops here.
      default:
        break
    }
  }
  return ops
}
