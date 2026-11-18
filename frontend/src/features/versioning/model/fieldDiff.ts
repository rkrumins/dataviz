/**
 * fieldDiff — what changed on one entity, field by field and PROPERTY BY PROPERTY, named the way
 * the drawer names them: "Name", "Description", "owner in Technical/Physical" — never one
 * `properties: {…} → {…}` blob, and never bookkeeping (`version`, `childCount`, `_…`).
 *
 * One vocabulary for every surface that shows a change: Review & Save, the Changes tab, the Review
 * Center, commit diffs, revision compare and entity history. Pure, and built only for the change
 * someone opens.
 */
import { userProperties } from '@/lib/nodeFields'
import type { RevisionChange } from '@/services/versioningApiService'
import type { ChangeKind, FieldDelta, GraphChange } from './changeModel'

export interface FieldChange {
  /** What the drawer calls it. */
  label: string
  /** A property's folder ("Technical/Physical") — shown before its name. */
  folder?: string
  before: unknown
  after: unknown
  kind: 'added' | 'changed' | 'removed'
}

/** A field's place on its entity — `Description`, `Technical/Owner` — what a comment on it names. */
export const fieldPath = (f: FieldChange) => (f.folder ? `${f.folder}/${f.label}` : f.label)

type Bag = Record<string, unknown>
const asBag = (v: unknown): Bag => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : {})

/** A field by what it reads as, and the keys it is stored under (stored name first, then the
 *  canvas's) — in the order a person reads them. */
const NODE_FIELDS: [string, string[]][] = [
  ['Name', ['displayName', 'label']],
  ['Type', ['entityType', 'type']],
  ['Description', ['description']],
  ['Qualified name', ['qualifiedName']],
  ['Source system', ['sourceSystem']],
  ['Tags', ['tags', 'classifications']],
  ['Layer', ['layerAssignment']],
]
const EDGE_FIELDS: [string, string[]][] = [
  ['Relationship', ['edgeType', 'edge_type', 'relationship']],
  ['From', ['sourceEntityId', 'source_entity_id', 'sourceUrn', 'source']],
  ['To', ['targetEntityId', 'target_entity_id', 'targetUrn', 'target']],
  ['Confidence', ['confidence']],
]
const FIELD_LABEL: Record<string, string> = Object.fromEntries(
  [...NODE_FIELDS, ...EDGE_FIELDS].flatMap(([label, keys]) => keys.map((k) => [k, label])),
)

/** Properties the drawer names for what they are, not by their key. */
const PROPERTY_LABEL: Record<string, string> = { businessLabel: 'Business label' }

/** Bookkeeping, not content: never a row (the technical view still shows the raw payload). */
const NOISE = new Set([
  'id', 'urn', 'entityId', 'entity_id', 'kind', 'version', 'discriminator',
  'childCount', 'lastSyncedAt', 'searchableText', 'level', 'levelDigest', 'gvHash',
  'urnSource', 'nameSource', 'propertiesRaw', 'createdAt', 'updatedAt', 'created_at', 'updated_at',
])

/** What a stored or canvas top-level field is called, if it is one the drawer names. */
export function fieldLabel(key: string): string | undefined {
  return FIELD_LABEL[key]
}

/** A property's name and folder: `Technical/Physical/owner` → owner, in Technical/Physical. */
export function propertyName(key: string): { label: string; folder?: string } {
  const cut = key.lastIndexOf('/')
  return {
    label: PROPERTY_LABEL[key] ?? (cut >= 0 ? key.slice(cut + 1) : key),
    folder: cut >= 0 ? key.slice(0, cut) : undefined,
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

function same(a: unknown, b: unknown): boolean {
  if (a === b || (isEmpty(a) && isEmpty(b))) return true
  if (typeof a !== 'object' || typeof b !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

const kindOf = (before: unknown, after: unknown): FieldChange['kind'] =>
  isEmpty(before) ? 'added' : isEmpty(after) ? 'removed' : 'changed'

/** One field's change, or nothing where it did not change. */
function row(label: string, before: unknown, after: unknown, folder?: string): FieldChange | null {
  if (same(before, after)) return null
  return { label, ...(folder ? { folder } : {}), before, after, kind: kindOf(before, after) }
}

/** A property's change, named as the drawer names it. */
export function propertyChange(key: string, before: unknown, after: unknown, kind?: FieldChange['kind']): FieldChange {
  const { label, folder } = propertyName(key)
  return { label, ...(folder ? { folder } : {}), before, after, kind: kind ?? kindOf(before, after) }
}

const byFolderThenName = (x: FieldChange, y: FieldChange) =>
  (x.folder ?? '').localeCompare(y.folder ?? '') || x.label.localeCompare(y.label)

/**
 * What changed between two snapshots of one entity: its named fields first (in reading order),
 * then each property that changed, by folder and name. A side missing is an added (or removed)
 * entity — every field it has is listed. Takes the stored shape (`displayName`, nested
 * `properties`), the canvas's (`label`, `classifications`) and a legacy flattened edge (properties
 * spread at the top level) alike.
 */
export function entityFieldChanges(before: unknown, after: unknown, kind: ChangeKind = 'node'): FieldChange[] {
  const b = asBag(before)
  const a = asBag(after)
  const fields = kind === 'edge' ? EDGE_FIELDS : NODE_FIELDS
  const out: FieldChange[] = []
  const known = new Set<string>()
  const pick = (bag: Bag, keys: string[]) => {
    for (const k of keys) if (k in bag) return bag[k]
    return undefined
  }
  for (const [label, keys] of fields) {
    keys.forEach((k) => known.add(k))
    const r = row(label, pick(b, keys), pick(a, keys))
    if (r) out.push(r)
  }

  const bp = userProperties(b.properties)
  const ap = userProperties(a.properties)
  const props: FieldChange[] = []
  for (const key of new Set([...Object.keys(bp), ...Object.keys(ap)])) {
    if (key.startsWith('_')) continue
    const { label, folder } = propertyName(key)
    const r = row(label, bp[key], ap[key], folder)
    if (r) props.push(r)
  }
  // Anything else at the top level: an edge's legacy-flattened properties, or a field of a node no
  // one named — by its key. A canvas mirror of a property (`businessLabel`) is that property.
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (key === 'properties' || known.has(key) || key.startsWith('_') || NOISE.has(key)) continue
    if (key in bp || key in ap) continue
    if (kind === 'edge' && key === 'type') continue // the canvas's renderer, not the relationship
    const { label, folder } = propertyName(key)
    const r = row(label, b[key], a[key], folder)
    if (r) props.push(r)
  }
  return [...out, ...props.sort(byFolderThenName)]
}

/** An entity's named fields that have a value — `Name`, `Type`, `Description`… (an edge's
 *  `Relationship`, `From`, `To`) — in reading order, as one snapshot reads (a revision "as it was"). */
export function namedFields(value: unknown, kind: ChangeKind = 'node'): Array<{ label: string; value: unknown }> {
  const bag = asBag(value)
  const out: Array<{ label: string; value: unknown }> = []
  for (const [label, keys] of kind === 'edge' ? EDGE_FIELDS : NODE_FIELDS) {
    const key = keys.find((k) => k in bag && bag[k] !== null && bag[k] !== undefined && bag[k] !== '')
    if (key) out.push({ label, value: bag[key] })
  }
  return out
}

/** Shallow field deltas (a `properties` delta among them) → one row per field and per property. */
export function fromFieldDeltas(deltas: readonly FieldDelta[], kind: ChangeKind = 'node'): FieldChange[] {
  const before: Bag = {}
  const after: Bag = {}
  for (const d of deltas) {
    before[d.field] = d.before
    after[d.field] = d.after
  }
  return entityFieldChanges(before, after, kind)
}

/** A revision's changes, as the history endpoint lists them (`['properties', 'owner']`, `['description']`). */
export function fromRevisionChanges(changes: readonly RevisionChange[]): FieldChange[] {
  const out: FieldChange[] = []
  const props: FieldChange[] = []
  for (const c of changes) {
    const [head, ...rest] = c.path
    if (head === 'properties' && rest.length > 0) {
      props.push(propertyChange(rest.join('.'), c.before, c.after, c.kind))
    } else if (head && !NOISE.has(head) && !head.startsWith('_')) {
      out.push({ label: c.path.length === 1 ? (FIELD_LABEL[head] ?? head) : c.path.join('.'), before: c.before, after: c.after, kind: c.kind })
    }
  }
  return [...out, ...props.sort(byFolderThenName)]
}

/** "2 changed · 1 added" — how a list of field changes reads in a line. */
export function fieldChangeCounts(fields: readonly FieldChange[]): Record<FieldChange['kind'], number> {
  const n = { added: 0, changed: 0, removed: 0 }
  for (const f of fields) n[f.kind] += 1
  return n
}

// ── Seeing a change at a glance: a summary line, its key differences, its sections ───────────────

const NAMED_LABELS = new Set([...NODE_FIELDS, ...EDGE_FIELDS].map(([label]) => label))
const KIND_RANK: Record<FieldChange['kind'], number> = { changed: 0, added: 1, removed: 2 }
const isNamed = (f: FieldChange) => !f.folder && NAMED_LABELS.has(f.label)

/** The fields to show first, at most `n`: the named ones in reading order (Name, Type,
 *  Description…), then properties edited, added, then removed — each in the order given (by
 *  folder, then name). What a person reads to know what a change is about. */
export function keyDifferences(fields: readonly FieldChange[], n = 5): FieldChange[] {
  const named = fields.filter(isNamed)
  const rest = fields.filter((f) => !isNamed(f))
    .map((f, i) => [f, i] as const)
    .sort(([a, i], [b, j]) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || i - j)
    .map(([f]) => f)
  return [...named, ...rest].slice(0, n)
}

export interface FieldSummary {
  changed: number
  added: number
  removed: number
  total: number
  /** The first few, as `keyDifferences` orders them: label and how it changed. */
  top: Array<{ label: string; folder?: string | null; kind: FieldChange['kind']; before?: unknown; after?: unknown }>
}

/** A change's fields counted, with the first few named — what its one-line summary reads. */
export function summarizeFields(fields: readonly FieldChange[], top = 3): FieldSummary {
  const n = fieldChangeCounts(fields)
  return { ...n, total: fields.length, top: keyDifferences(fields, top) }
}

export interface FieldSection {
  /** The folder (`Technical/Physical`), or null for the entity's own fields and loose properties. */
  folder: string | null
  fields: FieldChange[]
  counts: Record<FieldChange['kind'], number>
}

/** Fields in sections: the unfoldered first, then each folder in order. */
export function byFolder(fields: readonly FieldChange[]): FieldSection[] {
  const map = new Map<string | null, FieldChange[]>()
  for (const f of fields) {
    const key = f.folder ?? null
    const list = map.get(key)
    if (list) list.push(f)
    else map.set(key, [f])
  }
  const keys = [...map.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : a.localeCompare(b)))
  return keys.map((folder) => {
    const list = map.get(folder)!
    return { folder, fields: list, counts: fieldChangeCounts(list) }
  })
}

/** The server's summary of a change (`fields.top`) as field changes a row can show. */
export function fromSummaryTop(top: FieldSummary['top']): FieldChange[] {
  return top.map((t) => ({ label: t.label, folder: t.folder ?? undefined, kind: t.kind, before: t.before, after: t.after }))
}

/** A change's rows: from its two sides where it has them, else from its field deltas. */
export function fieldsOfChange(change: GraphChange): FieldChange[] {
  if (change.status === 'modified' && !(change.before && change.after) && change.fields) {
    return fromFieldDeltas(change.fields, change.kind)
  }
  return entityFieldChanges(change.status === 'added' ? undefined : change.before,
    change.status === 'removed' ? undefined : change.after, change.kind)
}
