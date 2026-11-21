/**
 * opModel — one bulk property change, as the guided dialog builds it: WHAT (the operation and its
 * property), WHERE (which entities — a preset or criteria, in the view or the whole data source)
 * and what the Review step counts before it is applied.
 *
 * The server applies it to a draft as a job (`property-jobs`): every entity the criteria match,
 * however many, a window at a time. Structural targets are plain searches the server walks from
 * an entity — a container's children, everything inside it, a layer — so they reach entities the
 * canvas has never loaded.
 *
 * Relationships are changed the same way (`isEdgeTarget`): named ones, or every one a Connections
 * search matches.
 */
import type { Predicate } from '@/types/search'
import type { PropertyJobOp, PropertyJobTarget, PropertyOpKind } from '@/services/versioningApiService'
import { RESERVED_PROPERTY_KEYS } from '@/lib/nodeFields'

export type ScopeMode = 'view' | 'data_source'

/** Which entities a change reaches. */
export type TargetPreset =
  | { kind: 'view' }
  | { kind: 'hasKey'; key: string }
  | { kind: 'selection'; ids: readonly string[] }
  | { kind: 'layer'; layerId: string; name: string }
  | { kind: 'children'; urns: readonly string[]; label: string }
  | { kind: 'inside'; urns: readonly string[]; label: string; includeSelf: boolean }
  | { kind: 'search'; predicate: Predicate; scopeMode: ScopeMode; label: string; count?: number }
  | { kind: 'custom'; predicate: Predicate | null }
  /** Relationships by id: an edge's own, or `source|TYPE|target`. */
  | { kind: 'relationships'; ids: readonly string[] }
  /** Every relationship a Connections search (an `edges` predicate) matches. */
  | { kind: 'connections'; predicate: Predicate; scopeMode: ScopeMode; label: string; count?: number }

/** A change of relationships, not entities. */
export const isEdgeTarget = (preset: TargetPreset) => preset.kind === 'relationships' || preset.kind === 'connections'

/** A Connections search — an `edges` predicate, alone or as the one condition of an AND. */
export function isConnectionsPredicate(p: Predicate | null | undefined): boolean {
  const q = p as { kind?: string; op?: string; children?: Predicate[] } | null | undefined
  if (q?.kind === 'edges') return true
  return q?.kind === 'group' && (q.op ?? 'and') === 'and' && q.children?.length === 1 && isConnectionsPredicate(q.children[0])
}

/** A search's matches as a target: its relationships, for a Connections search. */
export function searchPreset(predicate: Predicate, scopeMode: ScopeMode, count?: number): TargetPreset {
  return isConnectionsPredicate(predicate)
    ? { kind: 'connections', predicate, scopeMode, label: 'the search’s relationships', ...(count !== undefined ? { count } : {}) }
    : { kind: 'search', predicate, scopeMode, label: 'the search’s matches', ...(count !== undefined ? { count } : {}) }
}

/** An edge's own fields — never a property of one: the mirror of `EDGE_NATIVE_KEYS` in
 *  `backend/common/edge_properties.py` (a parity test pins the two). */
export const EDGE_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'id', 'confidence', 'gvHash',
  'aggKey', 'weight', 'sourceEdgeTypes', 'sourceLevel', 'targetLevel',
  'sourceDepth', 'targetDepth', 'levelDigest', 'gvSeq', 'latestUpdate',
])

/** Structural targets name at most this many containers: the search's limit on one OR. */
export const MAX_CONTAINERS = 24
/** A selection is sent as its ids — at most this many. */
export const MAX_IDS = 20_000
/** Names are at most this long: the longest a search can look a property up by. */
export const NAME_MAX = 128
/** Past this many entities — or across the whole data source — a removal, a rename or an
 *  overwriting set asks for the property's name to be typed before it is applied. */
export const CONFIRM_ABOVE = 1_000

export const OP_LABEL: Record<PropertyOpKind, string> = {
  set: 'Set value', fillEmpty: 'Fill if empty', rename: 'Rename', copy: 'Copy to new', remove: 'Remove',
}

const is = (urn: string): Predicate => ({ kind: 'is', refs: [{ urn }] } as Predicate)
const anyOf = (children: Predicate[]): Predicate =>
  children.length === 1 ? children[0]! : ({ kind: 'group', op: 'or', children } as Predicate)

/** The criteria a preset stands for — null for a selection (sent as ids) or criteria not finished. */
export function predicateOf(preset: TargetPreset): Predicate | null {
  switch (preset.kind) {
    case 'view': return { kind: 'all' } as Predicate
    case 'hasKey': return { kind: 'hasProperty', key: preset.key, negate: false } as Predicate
    case 'selection': return null
    case 'layer': return { kind: 'layer', layerAssignment: preset.layerId } as Predicate
    // One level down the containment tree from each container: its children.
    case 'children': return anyOf(preset.urns.map((urn) => ({ kind: 'related', axis: 'parent', where: is(urn) } as Predicate)))
    // Everything below each container — and the container too, when asked.
    case 'inside': return preset.includeSelf
      ? ({ kind: 'descendantOf', urns: [...preset.urns] } as Predicate)
      : anyOf(preset.urns.map((urn) => ({ kind: 'related', axis: 'ancestor', where: is(urn) } as Predicate)))
    case 'search': return preset.predicate
    case 'custom': return preset.predicate
    case 'relationships': return null
    case 'connections': return preset.predicate
  }
}

/** A layer is placed by the view: it is only ever searched in the view. */
export const scopeFixedToView = (preset: TargetPreset) => preset.kind === 'layer'

/** What the server is sent as the change's target, or null while it can't be. */
export function targetOf(preset: TargetPreset, viewId: string, scopeMode: ScopeMode): PropertyJobTarget | null {
  if (preset.kind === 'selection') return preset.ids.length > 0 ? { ids: [...preset.ids].slice(0, MAX_IDS) } : null
  if (preset.kind === 'relationships') return preset.ids.length > 0 ? { edgeIds: [...preset.ids].slice(0, MAX_IDS) } : null
  const predicate = predicateOf(preset)
  if (!predicate) return null
  return { viewId, predicate, scopeMode: scopeFixedToView(preset) ? 'view' : scopeMode }
}

/** How the target reads, in a sentence ("the children of Orders"). */
export function targetLabel(preset: TargetPreset): string {
  switch (preset.kind) {
    case 'view': return 'every entity in this view'
    case 'hasKey': return `every entity with ${preset.key}`
    case 'selection': return `the ${preset.ids.length.toLocaleString()} selected`
    case 'layer': return `the ${preset.name} layer`
    case 'children': return `the children of ${preset.label}`
    case 'inside': return `everything inside ${preset.label}${preset.includeSelf ? ', and it' : ''}`
    case 'search': return preset.label
    case 'custom': return 'the entities matching your criteria'
    case 'relationships': return `the ${preset.ids.length.toLocaleString()} selected relationships`
    case 'connections': return preset.label
  }
}

export interface OpDraft {
  kind: PropertyOpKind
  key: string
  to: string
  value: unknown
  onConflict: 'skip' | 'overwrite'
}

export const needsValue = (kind: PropertyOpKind) => kind === 'set' || kind === 'fillEmpty'
export const needsTo = (kind: PropertyOpKind) => kind === 'rename' || kind === 'copy'

/** Why a name can't be used, or null. `edges`: a relationship's property, which an edge's own
 *  fields can't be named. */
export function nameProblem(name: string, edges = false): string | null {
  const n = name.trim()
  if (!n) return 'Name the property'
  if ((edges ? EDGE_RESERVED_KEYS : RESERVED_PROPERTY_KEYS).has(n)) return `“${n}” is kept by the platform — pick another name`
  if (n.length > NAME_MAX) return `Names are at most ${NAME_MAX} characters`
  return null
}

/** Why the operation can't be applied yet, or null when it can. */
export function opProblem(op: OpDraft, edges = false): string | null {
  const keyProblem = nameProblem(op.key, edges)
  if (keyProblem) return keyProblem
  if (needsTo(op.kind)) {
    const toProblem = nameProblem(op.to, edges)
    if (toProblem) return toProblem === 'Name the property' ? 'Name the new property' : toProblem
    if (op.to.trim() === op.key.trim()) return 'The new name is the same as the old one'
  }
  if (needsValue(op.kind) && (op.value === undefined || op.value === '')) return 'Give it a value'
  return null
}

/** The operation as the server takes it. */
export function jobOp(op: OpDraft): PropertyJobOp {
  return {
    kind: op.kind,
    key: op.key.trim(),
    ...(needsTo(op.kind) ? { to: op.to.trim(), onConflict: op.onConflict } : {}),
    ...(needsValue(op.kind) ? { value: op.value } : {}),
  }
}

/** What Review counts, exactly, before the change is applied: the entities it targets, those of
 *  them holding the property (a set replaces their value; a fill leaves them alone), and — for a
 *  rename or a copy — those already holding the new name. */
export function reviewCounts(op: OpDraft, target: Predicate): Array<{ id: 'target' | 'haveKey' | 'haveTo'; predicate: Predicate }> {
  const and = (...children: Predicate[]) => ({ kind: 'group', op: 'and', children } as Predicate)
  // A Connections search's relationships that hold a key: the same search, each edge also holding it.
  if (isConnectionsPredicate(target)) {
    const items: Array<{ id: 'target' | 'haveKey' | 'haveTo'; predicate: Predicate }> = [{ id: 'target', predicate: target }]
    if (op.key.trim()) items.push({ id: 'haveKey', predicate: withEdgeKey(target, op.key.trim()) })
    if (needsTo(op.kind) && op.to.trim()) items.push({ id: 'haveTo', predicate: withEdgeKey(target, op.to.trim()) })
    return items
  }
  const has = (key: string) => ({ kind: 'hasProperty', key, negate: false } as Predicate)
  const items: Array<{ id: 'target' | 'haveKey' | 'haveTo'; predicate: Predicate }> = [{ id: 'target', predicate: target }]
  if (op.key.trim()) items.push({ id: 'haveKey', predicate: and(target, has(op.key.trim())) })
  if (needsTo(op.kind) && op.to.trim()) items.push({ id: 'haveTo', predicate: and(target, has(op.to.trim())) })
  return items
}

/** A Connections search whose every edge also holds `key`. */
function withEdgeKey(predicate: Predicate, key: string): Predicate {
  const q = predicate as { kind: string; children?: Predicate[]; edgePredicate?: unknown }
  const edges = (q.kind === 'edges' ? q : q.children![0]) as { edgePredicate?: unknown }
  const has = { kind: 'edgeHasProperty', key, negate: false }
  const edgePredicate = edges.edgePredicate ? { kind: 'edgeGroup', op: 'and', children: [edges.edgePredicate, has] } : has
  return { ...edges, edgePredicate } as Predicate
}

/** What the change does to the entities counted: how many it changes, replaces, leaves alone. */
export function impactOf(op: OpDraft, c: { target?: number; haveKey?: number; haveTo?: number }) {
  const target = c.target ?? 0
  const haveKey = c.haveKey ?? 0
  switch (op.kind) {
    case 'set': return { changes: target, replaced: haveKey, untouched: 0 }
    case 'fillEmpty': return { changes: Math.max(0, target - haveKey), replaced: 0, untouched: haveKey }
    case 'remove': return { changes: haveKey, replaced: 0, untouched: Math.max(0, target - haveKey) }
    case 'rename':
    case 'copy': {
      // Of those holding the property, the ones already holding the new name are left alone —
      // unless replacing. A floor: the server counts each one exactly as it goes.
      const conflicts = Math.min(haveKey, c.haveTo ?? 0)
      return op.onConflict === 'overwrite'
        ? { changes: haveKey, replaced: conflicts, untouched: Math.max(0, target - haveKey) }
        : { changes: Math.max(0, haveKey - conflicts), replaced: 0, untouched: Math.max(0, target - haveKey) + conflicts }
    }
  }
}

/** Whether applying it asks for the property's name to be typed first: a removal or a rename, or a
 *  set that replaces values — past `CONFIRM_ABOVE` entities, or anywhere across the data source. */
export function needsTypedConfirm(op: OpDraft, impact: { changes: number; replaced: number }, scopeMode: ScopeMode): boolean {
  const affected = op.kind === 'set' ? impact.replaced : op.kind === 'remove' || op.kind === 'rename' ? impact.changes : 0
  if (affected === 0 && !(scopeMode === 'data_source' && (op.kind === 'remove' || op.kind === 'rename'))) return false
  return affected >= CONFIRM_ABOVE || scopeMode === 'data_source'
}

/** A change in a few words: "Rename owner → steward". */
export function propertyJobLabel(op: PropertyJobOp): string {
  switch (op.kind) {
    case 'set': return `Set ${op.key}`
    case 'fillEmpty': return `Fill ${op.key}`
    case 'remove': return `Remove ${op.key}`
    case 'rename': return `Rename ${op.key} → ${op.to ?? ''}`
    case 'copy': return `Copy ${op.key} → ${op.to ?? ''}`
  }
}
