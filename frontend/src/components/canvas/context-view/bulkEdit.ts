/**
 * bulkEdit — what several entities share, and one edit staged for all of them.
 *
 * Reading: for a selection of entities, each field is the SAME on all of them (one value to
 * show), DIFFERS (all hold it, not all alike), or is PARTIAL (only some hold it — "on 7 of 12").
 * Each field also says which values it holds and which entities hold each one, so the reader can
 * see where they differ, not only that they do. That is what lets several records be read and
 * edited as one.
 *
 * Writing: an edit — a description for all, properties set for all, set only where missing,
 * renamed or copied, removed from all — is staged as each entity's own edit through
 * `stageNodeEdit`, so a node still has at most one staged change (an earlier edit of it merges
 * in), an entity the edit leaves as it was stages nothing, and Review & Save sends the lot as one
 * batch — staged in one write, as one Undo step (`stageNodeEdits`), so 10,000 entities are edited
 * as fast as ten. Undo puts the staged changes and the canvas back as they were before.
 */
import { applyNodePatch, userProperties } from '@/lib/nodeFields'
import { inferFieldType, type FieldType } from '@/components/panels/property/fieldTypes'
import { stageNodeEdits } from '@/features/versioning/model/stageNodeEdit'
import type { LineageNode } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

type Data = Record<string, unknown>

/** One value a field holds, and the entities that hold it. */
export interface ValueGroup {
  /** Stable for the value: equal values share it. */
  id: string
  value: unknown
  nodeIds: string[]
}

export interface SharedField {
  key: string
  /** The same on every entity, or not. */
  state: 'same' | 'mixed'
  /** `same` on all; `differs`: all hold it, not all alike; `partial`: some don't hold it. */
  kind: 'same' | 'differs' | 'partial'
  /** The shared value, when `same`. */
  value?: unknown
  /** How many entities have a value for it. */
  has: number
  /** How many entities there are. */
  total: number
  /** The values held, most held first. */
  groups: ValueGroup[]
  /** The friendly type most of its values read as — what a value typed for all is kept as. */
  type: FieldType
}

const present = (v: unknown) => v !== undefined && v !== null && v !== ''
const valueId = (v: unknown) =>
  v !== null && typeof v === 'object' ? `json:${JSON.stringify(v)}` : `${typeof v}:${String(v)}`
const sameValue = (a: unknown, b: unknown) => valueId(a) === valueId(b)

interface Tally { groups: Map<string, ValueGroup>; has: number }

function tallyInto(tally: Tally, nodeId: string, v: unknown) {
  if (!present(v)) return
  tally.has++
  const id = valueId(v)
  const g = tally.groups.get(id)
  if (g) g.nodeIds.push(nodeId)
  else tally.groups.set(id, { id, value: v, nodeIds: [nodeId] })
}

function fieldOf(key: string, tally: Tally, total: number): SharedField {
  const groups = [...tally.groups.values()].sort((a, b) => b.nodeIds.length - a.nodeIds.length)
  const kind = tally.has < total ? 'partial' : groups.length === 1 ? 'same' : 'differs'
  const byType = new Map<FieldType, number>()
  for (const g of groups) {
    const t = inferFieldType(g.value)
    byType.set(t, (byType.get(t) ?? 0) + g.nodeIds.length)
  }
  let type: FieldType = 'text'
  let most = 0
  for (const [t, n] of byType) if (n > most) { type = t; most = n }
  const base = { key, kind, has: tally.has, total, groups, type } as const
  return kind === 'same' ? { ...base, state: 'same', value: groups[0]!.value } : { ...base, state: 'mixed' }
}

/** The description and every user property across `nodes`, each same, differing or partial —
 *  one pass over every entity's properties. */
export function sharedFields(nodes: ReadonlyArray<{ id: string; data: Data }>): { description: SharedField; properties: SharedField[] } {
  const description: Tally = { groups: new Map(), has: 0 }
  const tallies = new Map<string, Tally>()
  for (const n of nodes) {
    tallyInto(description, n.id, n.data.description)
    const bag = userProperties(n.data.properties)
    for (const key in bag) {
      let t = tallies.get(key)
      if (!t) tallies.set(key, (t = { groups: new Map(), has: 0 }))
      tallyInto(t, n.id, bag[key])
    }
  }
  const keys = [...tallies.keys()].sort((a, b) => a.localeCompare(b))
  return {
    description: fieldOf('description', description, nodes.length),
    properties: keys.map((k) => fieldOf(k, tallies.get(k)!, nodes.length)),
  }
}

/** The entities of `nodeIds` that hold no value for `field`. */
export function missingNodeIds(field: SharedField, nodeIds: readonly string[]): string[] {
  if (field.has === field.total) return []
  const holding = new Set<string>()
  for (const g of field.groups) for (const id of g.nodeIds) holding.add(id)
  return nodeIds.filter((id) => !holding.has(id))
}

/** A property renamed — or copied, keeping the original — on every entity that holds it. */
export interface PropertyMove {
  from: string
  to: string
  /** Copy: keep `from` as well. */
  keep?: boolean
  /** Where `to` already holds a value, replace it; otherwise that entity is left as it is. */
  overwrite?: boolean
}

export interface BulkEdit {
  /** A description for all; absent leaves each one as it is. */
  description?: string
  /** Properties set to the same value on all. */
  set: Record<string, unknown>
  /** Properties set only on the entities that hold no value for them. */
  fill?: Record<string, unknown>
  /** Properties renamed or copied, read from the values as they were. */
  moves?: PropertyMove[]
  /** Properties removed from all. */
  unset: string[]
}

/** How many changes the edit makes — one per field it touches. */
export const bulkEditSize = (edit: BulkEdit) =>
  (edit.description !== undefined ? 1 : 0) + Object.keys(edit.set).length + Object.keys(edit.fill ?? {}).length
  + (edit.moves?.length ?? 0) + edit.unset.length

export const isEmptyBulkEdit = (edit: BulkEdit) => bulkEditSize(edit) === 0

/**
 * The edit as one entity's patch: what to set and what to remove from its `props`, in the order
 * moves → set → fill → unset, and how many of its values that replaces or leaves alone (a rename
 * onto a name it already holds, without `overwrite`). Nothing is set that it already holds.
 */
export function patchFor(props: Data, edit: BulkEdit): { set: Data; unset: string[]; overwritten: number; skipped: number } {
  const set: Data = {}
  const unset = new Set<string>()
  let overwritten = 0
  let skipped = 0
  for (const m of edit.moves ?? []) {
    const v = props[m.from]
    if (!present(v)) continue
    if (present(props[m.to])) {
      if (!m.overwrite) { skipped++; continue }
      if (!sameValue(props[m.to], v)) overwritten++
    }
    set[m.to] = v
    unset.delete(m.to)
    if (!m.keep) unset.add(m.from)
  }
  for (const [k, v] of Object.entries(edit.set)) {
    if (sameValue(props[k], v) && !(k in set) && !unset.has(k)) continue
    if (present(props[k]) && !sameValue(props[k], v)) overwritten++
    set[k] = v
    unset.delete(k)
  }
  for (const [k, v] of Object.entries(edit.fill ?? {})) {
    if (!present(props[k]) && !(k in set)) set[k] = v
  }
  for (const k of edit.unset) {
    delete set[k]
    if (k in props) unset.add(k)
  }
  return { set, unset: [...unset], overwritten, skipped }
}

/** What staging `edit` on `nodes` would do: how many entities it changes, and how many values
 *  it replaces or leaves alone. */
export function previewBulkEdit(nodes: ReadonlyArray<{ data: Data }>, edit: BulkEdit) {
  let entities = 0
  let overwritten = 0
  let skipped = 0
  for (const n of nodes) {
    const p = patchFor(userProperties(n.data.properties), edit)
    overwritten += p.overwritten
    skipped += p.skipped
    const describes = edit.description !== undefined && (n.data.description ?? '') !== edit.description
    if (describes || Object.keys(p.set).length > 0 || p.unset.length > 0) entities++
  }
  return { entities, changes: bulkEditSize(edit), overwritten, skipped }
}

/**
 * Stage `edit` on every node, each as its own edit, as one action. Returns how
 * to undo it: the Undo step it made — while it is still the last thing done.
 */
export function stageBulkEdit(nodes: readonly LineageNode[], edit: BulkEdit): () => void {
  const edits = []
  for (const node of nodes) {
    const data = node.data as Data
    const p = patchFor(userProperties(data.properties), edit)
    const payload: Data = {}
    if (edit.description !== undefined) payload.description = edit.description
    if (Object.keys(p.set).length > 0) payload.properties = p.set
    if (Object.keys(payload).length === 0 && p.unset.length === 0) continue
    edits.push({ nodeId: node.id, current: node.data, after: applyNodePatch(data, payload, p.unset) as LineageNode['data'] })
  }
  const step = edits.length > 0 ? stageNodeEdits(edits) : null
  return () => {
    const s = useStagedChangesStore.getState()
    if (step && s.past[s.past.length - 1]?.id === step) s.undo()
  }
}
