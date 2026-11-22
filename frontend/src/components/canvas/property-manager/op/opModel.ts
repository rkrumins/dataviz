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
 * Besides changing a property (set, fill, rename, copy, remove) it cleans up the values it holds:
 * find & replace, normalize, merge near-duplicate values, convert every value to one kind.
 * Relationships are changed the same way (`isEdgeTarget`): named ones, or every one a Connections
 * search matches.
 */
import type { Predicate } from '@/types/search'
import type { PropertyJobOp, PropertyJobTarget, PropertyOpKind, ValueKind, ValueMapping } from '@/services/versioningApiService'
import { RESERVED_PROPERTY_KEYS } from '@/lib/nodeFields'

export type ScopeMode = 'view' | 'data_source'

/** Which entities a change reaches. */
export type TargetPreset =
  | { kind: 'view' }
  | { kind: 'hasKey'; key: string }
  /** `label`: what the ids are, when they aren't the canvas selection (a publish's refusals), and
   *  `entityTypes` their types, when known. */
  | { kind: 'selection'; ids: readonly string[]; label?: string; entityTypes?: readonly string[] }
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
/** Changed entities past which a draft's counts and property list show the published graph, and it
 *  is slower to open — the server's GRAPHVER_DRAFT_SEARCH_MAX_DELTA, at its default. */
export const DRAFT_LARGE = 200_000
/** Names are at most this long: the longest a search can look a property up by. */
export const NAME_MAX = 128
/** Past this many entities — or across the whole data source — a removal, a rename or an
 *  overwriting set asks for the property's name to be typed before it is applied. */
export const CONFIRM_ABOVE = 1_000

export const OP_LABEL: Record<PropertyOpKind, string> = {
  set: 'Set value', fillEmpty: 'Fill if empty', rename: 'Rename', copy: 'Copy to new', remove: 'Remove',
  replace: 'Find & replace', normalize: 'Normalize', mapValues: 'Merge values', convert: 'Convert kind',
}

/** The operations that clean up the values a property holds, where it is held. */
export const CLEANUP_KINDS = ['replace', 'normalize', 'mapValues', 'convert'] as const satisfies readonly PropertyOpKind[]
export type CleanupKind = typeof CLEANUP_KINDS[number]
export const isCleanup = (kind: PropertyOpKind): kind is CleanupKind => (CLEANUP_KINDS as readonly PropertyOpKind[]).includes(kind)
/** Find and replace take at most this many characters each. */
export const FIND_MAX = 256
/** A merge names at most this many values. */
export const MAP_MAX = 1_000

/** How each kind a value is stored as reads (the catalog's labels). */
export const VALUE_KIND_LABEL: Record<ValueKind, string> = { Integer: 'Integer', Float: 'Decimal', String: 'Text', Boolean: 'Boolean' }

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

/** Why a selection can't be sent as its ids — more of them than one change names — or null. It is
 *  never cut short: a change applied to part of what it says it changes is the wrong change.
 *  `instead`: the other targets offered, by their titles — named as the way on. */
export function tooManyIds(preset: TargetPreset, instead: readonly string[] = []): string | null {
  if ((preset.kind !== 'selection' && preset.kind !== 'relationships') || preset.ids.length <= MAX_IDS) return null
  if (preset.kind === 'relationships') {
    return `${MAX_IDS.toLocaleString()} is the most a selection of relationships can change — use a Connections search instead.`
  }
  const named = instead.map((title) => `“${title}”`)
  const choices = named.length > 1 ? `${named.slice(0, -1).join(', ')} or ${named.at(-1)}` : named[0]
  return `${MAX_IDS.toLocaleString()} is the most a selection can change${choices ? ` — choose ${choices} instead` : ''}.`
}

/** What the server is sent as the change's target, or null while it can't be. */
export function targetOf(preset: TargetPreset, viewId: string, scopeMode: ScopeMode): PropertyJobTarget | null {
  if (preset.kind === 'selection') return preset.ids.length > 0 && !tooManyIds(preset) ? { ids: [...preset.ids] } : null
  if (preset.kind === 'relationships') return preset.ids.length > 0 && !tooManyIds(preset) ? { edgeIds: [...preset.ids] } : null
  const predicate = predicateOf(preset)
  if (!predicate) return null
  return { viewId, predicate, scopeMode: scopeFixedToView(preset) ? 'view' : scopeMode }
}

/** How the target reads, in a sentence ("the children of Orders"). */
export function targetLabel(preset: TargetPreset): string {
  switch (preset.kind) {
    case 'view': return 'every entity in this view'
    case 'hasKey': return `every entity with ${preset.key}`
    case 'selection': return preset.label ?? `the ${preset.ids.length.toLocaleString()} selected`
    case 'layer': return `the ${preset.name} layer`
    case 'children': return `the children of ${preset.label}`
    case 'inside': return `everything inside ${preset.label}${preset.includeSelf ? ', and it' : ''}`
    case 'search': return preset.label
    case 'custom': return 'the entities matching your criteria'
    case 'relationships': return `the ${preset.ids.length.toLocaleString()} selected relationships`
    case 'connections': return preset.label
  }
}

/** A target's words as a title: "every Table missing Owner" → "Every Table missing Owner". */
export const sentence = (label: string) => label.charAt(0).toUpperCase() + label.slice(1)

/** The target with the scope it reaches in: the whole view across the whole data source is the data
 *  source; any other target there says so after its own words. Picked by id, or a layer (always in
 *  the view), the scope doesn't apply. */
export function scopedTargetLabel(preset: TargetPreset, scope: ScopeMode): string {
  if (scope !== 'data_source' || preset.kind === 'selection' || preset.kind === 'relationships' || scopeFixedToView(preset)) {
    return targetLabel(preset)
  }
  return preset.kind === 'view' ? 'every entity in the data source' : `${targetLabel(preset)}, across the whole data source`
}

export interface OpDraft {
  kind: PropertyOpKind
  key: string
  to: string
  value: unknown
  onConflict: 'skip' | 'overwrite'
  /** Find & replace: in any case unless `matchCase`; only a value that is all of it with `wholeValue`. */
  find?: string
  replaceWith?: string
  matchCase?: boolean
  wholeValue?: boolean
  /** Normalize (trim is on unless turned off). */
  trim?: boolean
  collapseSpaces?: boolean
  case?: 'lower' | 'upper' | 'title' | null
  /** Normalize and merge: in a list, each value once (a merge's is on unless turned off). */
  dedupeList?: boolean
  /** Merge values. */
  map?: ValueMapping[]
  /** Convert: to this kind; a value that won't convert is left (`skip`) or removed. */
  toKind?: ValueKind
  onFail?: 'skip' | 'remove'
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
  // A clean-up previews the values the catalog holds — entities' only.
  if (edges && isCleanup(op.kind)) return 'Clean-ups are for entities — choose a change'
  if (needsTo(op.kind)) {
    const toProblem = nameProblem(op.to, edges)
    if (toProblem) return toProblem === 'Name the property' ? 'Name the new property' : toProblem
    if (op.to.trim() === op.key.trim()) return 'The new name is the same as the old one'
  }
  if (needsValue(op.kind) && (op.value === undefined || op.value === '')) return 'Give it a value'
  if (op.kind === 'replace') {
    if (!op.find) return 'Say what to find'
    if (op.find.length > FIND_MAX || (op.replaceWith ?? '').length > FIND_MAX) return `Find and replace take at most ${FIND_MAX} characters`
  }
  if (op.kind === 'normalize' && !((op.trim ?? true) || op.collapseSpaces || op.case || op.dedupeList)) return 'Choose what to tidy'
  if (op.kind === 'mapValues') {
    if (!op.map?.length) return 'Choose the values to merge'
    if (op.map.length > MAP_MAX) return `At most ${MAP_MAX.toLocaleString()} values merge at once`
  }
  if (op.kind === 'convert' && !op.toKind) return 'Choose the kind to convert to'
  return null
}

/** The operation as the server takes it. */
export function jobOp(op: OpDraft): PropertyJobOp {
  return {
    kind: op.kind,
    key: op.key.trim(),
    ...(needsTo(op.kind) ? { to: op.to.trim(), onConflict: op.onConflict } : {}),
    ...(needsValue(op.kind) ? { value: op.value } : {}),
    ...(op.kind === 'replace' ? { find: op.find ?? '', replaceWith: op.replaceWith ?? '', matchCase: !!op.matchCase, wholeValue: !!op.wholeValue } : {}),
    ...(op.kind === 'normalize'
      ? { trim: op.trim ?? true, collapseSpaces: !!op.collapseSpaces, case: op.case ?? null, dedupeList: !!op.dedupeList } : {}),
    ...(op.kind === 'mapValues' ? { map: op.map ?? [], dedupeList: op.dedupeList ?? true } : {}),
    ...(op.kind === 'convert' ? { toKind: op.toKind, onFail: op.onFail ?? 'skip' } : {}),
  }
}

/** What Review counts, exactly, before the change is applied: the entities it targets, those of
 *  them holding the property (a set replaces their value; a fill leaves them alone), and — for a
 *  rename or a copy — those already holding the new name; for a find & replace or a merge, those
 *  holding a value it could change (`match`: the text found, the values merged). */
export function reviewCounts(op: OpDraft, target: Predicate): Array<{ id: 'target' | 'haveKey' | 'haveTo' | 'match'; predicate: Predicate }> {
  const and = (...children: Predicate[]) => ({ kind: 'group', op: 'and', children } as Predicate)
  // A Connections search's relationships that hold a key: the same search, each edge also holding it.
  if (isConnectionsPredicate(target)) {
    const items: Array<{ id: 'target' | 'haveKey' | 'haveTo'; predicate: Predicate }> = [{ id: 'target', predicate: target }]
    if (op.key.trim()) items.push({ id: 'haveKey', predicate: withEdgeKey(target, op.key.trim()) })
    if (needsTo(op.kind) && op.to.trim()) items.push({ id: 'haveTo', predicate: withEdgeKey(target, op.to.trim()) })
    return items
  }
  const has = (key: string) => ({ kind: 'hasProperty', key, negate: false } as Predicate)
  const items: Array<{ id: 'target' | 'haveKey' | 'haveTo' | 'match'; predicate: Predicate }> = [{ id: 'target', predicate: target }]
  if (op.key.trim()) items.push({ id: 'haveKey', predicate: and(target, has(op.key.trim())) })
  if (needsTo(op.kind) && op.to.trim()) items.push({ id: 'haveTo', predicate: and(target, has(op.to.trim())) })
  const match = op.key.trim() ? matchPredicate(op) : null
  if (match) items.push({ id: 'match', predicate: and(target, match) })
  return items
}

/** The entities a fill, a find & replace or a merge could change: an empty value; text containing
 *  what it finds (or being it); or one of the values merged — compared as text exactly, as numbers
 *  or as yes/no. A bound: a number reads as text too, and 1 and 1.0 compare as one number. */
function matchPredicate(op: OpDraft): Predicate | null {
  const key = op.key.trim()
  // A fill reaches every entity whose value is empty — none, null, "" or [] — as the job judges it.
  if (op.kind === 'fillEmpty') return { kind: 'property', key, op: 'isEmpty' } as Predicate
  if (op.kind === 'replace' && op.find) {
    return { kind: 'property', key, op: op.wholeValue ? 'eq' : 'contains', value: op.find, valueType: 'string', caseSensitive: !!op.matchCase } as Predicate
  }
  if (op.kind !== 'mapValues' || !op.map?.length) return null
  const byType = new Map<string, unknown[]>()
  for (const m of op.map) {
    const type = typeof m.from === 'number' ? 'number' : typeof m.from === 'boolean' ? 'boolean' : 'string'
    byType.set(type, [...(byType.get(type) ?? []), m.from])
  }
  const parts = [...byType].map(([valueType, values]) => (
    { kind: 'property', key, op: 'in', value: values, valueType, ...(valueType === 'string' ? { caseSensitive: true } : {}) } as Predicate))
  return parts.length === 1 ? parts[0]! : ({ kind: 'group', op: 'or', children: parts } as Predicate)
}

/** A Connections search whose every edge also holds `key`. */
function withEdgeKey(predicate: Predicate, key: string): Predicate {
  const q = predicate as { kind: string; children?: Predicate[]; edgePredicate?: unknown }
  const edges = (q.kind === 'edges' ? q : q.children![0]) as { edgePredicate?: unknown }
  const has = { kind: 'edgeHasProperty', key, negate: false }
  const edgePredicate = edges.edgePredicate ? { kind: 'edgeGroup', op: 'and', children: [edges.edgePredicate, has] } : has
  return { ...edges, edgePredicate } as Predicate
}

export interface Impact {
  changes: number
  replaced: number
  untouched: number
  /** `changes` is a bound — at most this many: what a clean-up finds is only known as it runs. */
  upTo?: boolean
}

/** What the change does to the entities counted: how many it changes, replaces, leaves alone. A
 *  clean-up's is exact from the draft for named entities (`wouldChange`); otherwise at most those
 *  holding a value it could change — for a convert, those holding the property as another kind,
 *  read from the catalog's `kinds` (for the view) when given. */
export function impactOf(
  op: OpDraft,
  c: { target?: number; haveKey?: number; haveTo?: number; match?: number; wouldChange?: number },
  kinds?: Readonly<Record<string, number>> | null,
): Impact {
  const target = c.target ?? 0
  const haveKey = c.haveKey ?? 0
  if (isCleanup(op.kind)) {
    if (c.wouldChange !== undefined) return { changes: c.wouldChange, replaced: c.wouldChange, untouched: Math.max(0, target - c.wouldChange) }
    let changes = haveKey
    if ((op.kind === 'replace' || op.kind === 'mapValues') && c.match !== undefined) changes = Math.min(haveKey, c.match)
    if (op.kind === 'convert' && op.toKind && kinds) {
      const others = Object.entries(kinds).reduce((n, [kind, count]) => n + (kind === op.toKind ? 0 : count), 0)
      changes = Math.min(haveKey, others)
    }
    return { changes, replaced: changes, untouched: Math.max(0, target - changes), upTo: true }
  }
  switch (op.kind) {
    case 'set': return { changes: target, replaced: haveKey, untouched: 0 }
    case 'fillEmpty':
      // Those with an empty value, at most (a value of only spaces reads as empty to the search, and
      // is left alone); without that count, those without the key.
      if (c.match !== undefined) return { changes: c.match, replaced: 0, untouched: Math.max(0, target - c.match), upTo: true }
      return { changes: Math.max(0, target - haveKey), replaced: 0, untouched: haveKey }
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

/** What the Apply button says: how many it changes — "at most" for a bound, "about" for a count
 *  that isn't the draft's own, and "+" while it is still being counted. */
export function applyLabel(impact: Impact | null, final: boolean, exact: boolean): string {
  if (!impact) return 'Apply'
  const n = impact.changes.toLocaleString()
  return `Apply to ${!final ? `${n}+` : impact.upTo ? `at most ${n}` : exact ? n : `about ${n}`}`
}

/** Whether applying it asks for the property's name to be typed first: a removal, a rename or a
 *  clean-up, or a set (or a copy onto a name held) that replaces values — past `CONFIRM_ABOVE`
 *  entities, or anywhere across the data source. And always when what it changes isn't known
 *  exactly (`impact` null, or not `exact`): what it may lose can't be said to be small. */
export function needsTypedConfirm(
  op: OpDraft, impact: { changes: number; replaced: number } | null, scopeMode: ScopeMode, exact = true,
): boolean {
  const rewrites = op.kind === 'remove' || op.kind === 'rename' || isCleanup(op.kind)
  const overwrites = op.kind === 'set' || (op.kind === 'copy' && op.onConflict === 'overwrite')
  if (!impact || !exact) return rewrites || overwrites
  const affected = overwrites ? impact.replaced : rewrites ? impact.changes : 0
  if (affected === 0 && !(scopeMode === 'data_source' && rewrites)) return false
  return affected >= CONFIRM_ABOVE || scopeMode === 'data_source'
}

const quoted = (text: string | undefined) => {
  const t = text ?? ''
  return `“${t.length <= 40 ? t : `${t.slice(0, 39)}…`}”`
}

/** A change in a few words: "Rename owner → steward" — a clean-up as its commits name it on the
 *  server (`property_job.describe`). */
export function propertyJobLabel(op: PropertyJobOp): string {
  switch (op.kind) {
    case 'set': return `Set ${op.key}`
    case 'fillEmpty': return `Fill ${op.key}`
    case 'remove': return `Remove ${op.key}`
    case 'rename': return `Rename ${op.key} → ${op.to ?? ''}`
    case 'copy': return `Copy ${op.key} → ${op.to ?? ''}`
    case 'replace': return `Replace ${quoted(op.find)} → ${quoted(op.replaceWith)} in ${op.key}`
    case 'normalize': {
      const parts = [
        (op.trim ?? true) && 'trim', op.collapseSpaces && 'collapse spaces',
        op.case === 'lower' && 'lower case', op.case === 'upper' && 'UPPER CASE', op.case === 'title' && 'Title Case',
        op.dedupeList && 'each value once',
      ].filter(Boolean)
      return `Normalize ${op.key}${parts.length ? ` (${parts.join(', ')})` : ''}`
    }
    case 'mapValues': {
      const n = op.map?.length ?? 0
      return `Merge ${n.toLocaleString()} value${n === 1 ? '' : 's'} of ${op.key}`
    }
    case 'convert': return `Convert ${op.key} to ${op.toKind ? VALUE_KIND_LABEL[op.toKind] : '…'}`
    case 'undo': return `Undo: ${op.sourceLabel ?? 'a bulk change'}`
  }
}
