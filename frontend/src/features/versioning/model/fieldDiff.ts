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
import type { ChangeKind, FieldDelta } from './changeModel'

export interface FieldChange {
  /** What the drawer calls it. */
  label: string
  /** A property's folder ("Technical/Physical") — shown before its name. */
  folder?: string
  before: unknown
  after: unknown
  kind: 'added' | 'changed' | 'removed'
}

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
