/**
 * stagedChangesToOps — translate the canvas's staged edits into atomic `/graph/changes`
 * ops for a draft save. Handles entity mutations (rename/update/delete a node,
 * edit/delete/reverse an edge) plus user-drawn raw edges (`create_edge`);
 * `create_entity` is intentionally excluded — it
 * keeps going through the proven `provider.createNode` path (which constructs the urn and
 * the containment edge), and is run first by `saveStagedChangesToDraft`.
 *
 * Updates are *partial* (the backend merges onto current state), so we only emit the
 * fields that changed — but we normalize the canvas display shape (`label`/`type`) to the
 * backend `GraphNode` shape (`displayName`/`entityType`).
 */
import type { GraphChangeOp } from '@/services/versioningApiService'
import type { StagedChange } from '@/store/stagedChangesStore'

// Client-only / immutable edge keys that must never reach the backend (mirrors EdgeDetailPanel).
const IMMUTABLE_EDGE_KEYS = new Set([
  'edgeType', 'relationship', 'isAggregated', 'sourceEdgeCount', 'sourceEdges', 'animated',
])

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** Map the canvas node display shape → backend GraphNode fields (partial update). */
function nodeUpdatePayload(after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('displayName' in after) out.displayName = after.displayName
  else if ('label' in after) out.displayName = after.label
  if ('entityType' in after) out.entityType = after.entityType
  else if ('type' in after) out.entityType = after.type
  if ('tags' in after) out.tags = after.tags
  else if ('classifications' in after) out.tags = after.classifications
  if ('businessLabel' in after) out.businessLabel = after.businessLabel
  if ('technicalLabel' in after) out.technicalLabel = after.technicalLabel
  if (after.properties && typeof after.properties === 'object') out.properties = after.properties
  return out
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
        const payload = nodeUpdatePayload(asObj(c.after))
        if (Object.keys(payload).length > 0) {
          ops.push({ op: 'update', kind: 'node', id: c.targetUrn ?? c.targetId, payload })
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
          if (!IMMUTABLE_EDGE_KEYS.has(k)) payload[k] = v
        }
        ops.push({ op: 'update', kind: 'edge', id: c.targetId, payload })
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
      case 'retype_edge': {
        // Edge type isn't mutable in place — drop the original and recreate it
        // with the new type (under a NEW canvas id, so the delete and create in
        // this commit never target the same entity id). Mutable data (e.g.
        // confidence) is carried into the new edge.
        const before = asObj(asObj(c.before).edge)
        const after = asObj(asObj(c.after).edge)
        const data = asObj(after.data)
        const carried: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(data)) {
          if (!IMMUTABLE_EDGE_KEYS.has(k)) carried[k] = v
        }
        if (before.id) ops.push({ op: 'delete', kind: 'edge', id: String(before.id) })
        ops.push({
          op: 'create',
          kind: 'edge',
          id: c.targetId,
          payload: {
            edgeType: after.edgeType ?? data.edgeType,
            sourceEntityId: after.source != null ? resolveId(String(after.source)) : after.source,
            targetEntityId: after.target != null ? resolveId(String(after.target)) : after.target,
            ...carried,
          },
        })
        break
      }
      // create_entity → provider.createNode (handled in saveStagedChangesToDraft);
      // assign_layer / move_to_layer → view/blueprint config (referenceModelStore), not graph entities.
      default:
        break
    }
  }
  return ops
}
