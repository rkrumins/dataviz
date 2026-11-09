/**
 * bulkEdit — what several entities share, and one edit staged for all of them.
 *
 * Reading: for a selection of entities, each field is either the SAME on all
 * of them (one value to show), or MIXED (they differ, or only some have it —
 * "on 7 of 12"). That is what lets several records be read and edited as one.
 *
 * Writing: an edit — a description for all, properties set for all, properties
 * removed from all — is staged as each entity's own edit through
 * `stageNodeEdit`, so a node still has at most one staged change (an earlier
 * edit of it merges in), an entity the edit leaves as it was stages nothing,
 * and Review & Save sends the lot as one batch. Undo puts the staged changes
 * and the canvas back as they were before.
 */
import { applyNodePatch, userProperties } from '@/lib/nodeFields'
import { stageNodeEdit } from '@/features/versioning/model/stageNodeEdit'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

type Data = Record<string, unknown>

export interface SharedField {
  key: string
  /** The same on every entity, or not. */
  state: 'same' | 'mixed'
  /** The shared value, when `same`. */
  value?: unknown
  /** How many entities have a value for it. */
  has: number
  /** How many entities there are. */
  total: number
}

const present = (v: unknown) => v !== undefined && v !== null && v !== ''
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function fieldOf(key: string, values: unknown[]): SharedField {
  const total = values.length
  const has = values.filter(present).length
  const first = values[0]
  const same = has === total && values.every((v) => sameValue(v, first))
  return same ? { key, state: 'same', value: first, has, total } : { key, state: 'mixed', has, total }
}

/** The description and every user property across `nodes`, each same or mixed. */
export function sharedFields(nodes: ReadonlyArray<{ data: Data }>): { description: SharedField; properties: SharedField[] } {
  const bags = nodes.map((n) => userProperties(n.data.properties))
  const keys = [...new Set(bags.flatMap((b) => Object.keys(b)))].sort((a, b) => a.localeCompare(b))
  return {
    description: fieldOf('description', nodes.map((n) => n.data.description)),
    properties: keys.map((k) => fieldOf(k, bags.map((b) => b[k]))),
  }
}

export interface BulkEdit {
  /** A description for all; absent leaves each one as it is. */
  description?: string
  /** Properties set to the same value on all. */
  set: Record<string, unknown>
  /** Properties removed from all. */
  unset: string[]
}

export const isEmptyBulkEdit = (edit: BulkEdit) =>
  edit.description === undefined && Object.keys(edit.set).length === 0 && edit.unset.length === 0

/**
 * Stage `edit` on every node, each as its own edit. Returns how to undo it:
 * the staged changes and each node's data as they were.
 */
export function stageBulkEdit(nodes: readonly LineageNode[], edit: BulkEdit): () => void {
  const before = useStagedChangesStore.getState().changes
  const originals = nodes.map((n) => [n.id, n.data] as const)
  const payload: Data = {}
  if (edit.description !== undefined) payload.description = edit.description
  if (Object.keys(edit.set).length > 0) payload.properties = edit.set
  for (const node of nodes) {
    const current = node.data as Data
    stageNodeEdit(node.id, node.data, applyNodePatch(current, payload, edit.unset) as LineageNode['data'])
  }
  return () => {
    useStagedChangesStore.setState({ changes: before })
    const { updateNode } = useCanvasStore.getState()
    // `updateNode` merges: a field the edit added where there was none is
    // written back as absent, not left behind.
    for (const [id, data] of originals) {
      updateNode(id, { ...data, description: data.description, businessLabel: data.businessLabel })
    }
  }
}
