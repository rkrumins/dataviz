/**
 * Bridge from the backend's hierarchical-diff rows (`DiffTreeNode`) to the existing
 * change vocabulary, so a tree leaf renders through the same `EntityDiff` as the flat
 * ChangesPanel. The tree's grouping/labels come from the server; this only adapts a
 * single changed entity (a `leaf`) into a `GraphChange` for the before/after detail.
 */
import {
  deriveFieldDeltas,
  labelForPayload,
  type ChangeKind,
  type ChangeOrigin,
  type ChangeStatus,
  type GraphChange,
} from './changeModel'
import type { DiffTreeNode } from '@/services/versioningApiService'

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** Node vs edge from the payload shape (edges carry both endpoints) — only affects the
 *  fallback label, since the tree row shows the server label. */
function inferKind(p?: Record<string, unknown>): ChangeKind {
  if (!p) return 'node'
  const hasSrc = 'sourceEntityId' in p || 'source_entity_id' in p
  const hasTgt = 'targetEntityId' in p || 'target_entity_id' in p
  return hasSrc && hasTgt ? 'edge' : 'node'
}

/** A hierarchical-diff `leaf` → `GraphChange` for the `EntityDiff` before/after table. */
export function treeLeafToChange(node: DiffTreeNode, origin: ChangeOrigin): GraphChange {
  const before = asRecord(node.before)
  const after = asRecord(node.after)
  const status: ChangeStatus =
    node.status && node.status !== 'unchanged' ? node.status : 'modified'
  const kind = inferKind(after ?? before)
  return {
    entityId: node.key,
    kind,
    status,
    label: node.label || labelForPayload(node.key, after ?? before, kind),
    fields: status === 'modified' ? deriveFieldDeltas(before, after) : undefined,
    before,
    after,
    origin,
  }
}
