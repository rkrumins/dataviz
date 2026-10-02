/**
 * Where a node's fields live — the one module that decides.
 *
 * A stored node has TOP-LEVEL fields the platform owns (`displayName`, `description`,
 * `qualifiedName`, …) and a user `properties` bag. The canvas shows the same node in a display
 * shape (`label`, `type`, `classifications`, see `toCanvasNode`). Three things went wrong when
 * each surface decided placement for itself:
 *
 * - a field filed on the wrong side was dropped: the backend strips every reserved name out of
 *   `properties` (`_sanitize_node_properties`), so a description filed there vanished, and a
 *   schema field or business label written top-level was simply never stored;
 * - the draft reader mirrors reserved fields back INTO `properties` (`childCount`), so an editor
 *   that showed the whole bag offered them as user properties — and "deleting" one did nothing;
 * - a save that diffed the display shape against itself sent fields that never changed.
 */

/** Names the backend never keeps in `properties` — the mirror of `_RESERVED_NODE_KEYS` in
 *  `backend/app/providers/falkordb_provider.py` (a parity test pins the two). */
export const RESERVED_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  'urn', 'entityType', 'displayName', 'qualifiedName', 'description',
  'tags', 'layerAssignment', 'childCount', 'sourceSystem', 'lastSyncedAt',
  'level', 'levelDigest',
  'entityId', 'searchableText',
  'properties', 'propertiesRaw',
  'urnSource', 'nameSource',
  'gvHash',
])

type Bag = Record<string, unknown>

const asBag = (v: unknown): Bag =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Bag) : {}

/** The user's own properties: `props` without any reserved key. The same object when there is
 *  nothing to drop, so a memoised consumer does not re-render for nothing. */
export function userProperties(props: unknown): Bag {
  const bag = asBag(props)
  const keys = Object.keys(bag)
  if (!keys.some((k) => RESERVED_PROPERTY_KEYS.has(k))) return bag
  const out: Bag = {}
  for (const k of keys) if (!RESERVED_PROPERTY_KEYS.has(k)) out[k] = bag[k]
  return out
}

/** An edited user-property bag written back over `original`, keeping the reserved entries the
 *  reader mirrored into it — the editor never saw them, so it cannot have meant to drop them. */
export function withReserved(original: unknown, edited: Bag): Bag {
  const reserved = Object.entries(asBag(original)).filter(([k]) => RESERVED_PROPERTY_KEYS.has(k))
  return reserved.length ? { ...edited, ...Object.fromEntries(reserved) } : edited
}

/** Stored top-level node field → the key the canvas display shape carries it under. */
const CANVAS_KEY: Record<string, string> = {
  displayName: 'label',
  entityType: 'type',
  tags: 'classifications',
}

/** A field of the entity type's schema, read from wherever it is stored: a reserved name is a
 *  top-level field, anything else is a user property. */
export function readSchemaField(data: Bag, id: string): unknown {
  if (RESERVED_PROPERTY_KEYS.has(id)) return data[CANVAS_KEY[id] ?? id]
  return asBag(data.properties)[id]
}

/** `data` with a schema field set where it is stored (see `readSchemaField`). */
export function writeSchemaField(data: Bag, id: string, value: unknown): Bag {
  if (RESERVED_PROPERTY_KEYS.has(id)) return { ...data, [CANVAS_KEY[id] ?? id]: value }
  return { ...data, properties: { ...asBag(data.properties), [id]: value } }
}

/** The node's business label — a user property the canvas also surfaces as `data.businessLabel`. */
export function writeBusinessLabel(data: Bag, value: string): Bag {
  const properties = { ...asBag(data.properties) }
  if (value.trim()) properties.businessLabel = value
  else delete properties.businessLabel
  return { ...data, properties, businessLabel: value.trim() ? value : undefined }
}

/** Top-level fields a create may be handed inside a flat field map (the Hierarchy Builder's
 *  row details) — each is a node field, never a property. */
const LIFTED_FIELDS = ['description', 'qualifiedName', 'sourceSystem'] as const

/** Split a flat field map into the node's top-level fields and its user properties. */
export function splitNodeFields(fields: Bag): { topLevel: Bag; properties: Bag } {
  const topLevel: Bag = {}
  const properties: Bag = {}
  for (const [k, v] of Object.entries(fields)) {
    if ((LIFTED_FIELDS as readonly string[]).includes(k)) topLevel[k] = v
    else if (!RESERVED_PROPERTY_KEYS.has(k)) properties[k] = v
  }
  return { topLevel, properties }
}

/** The stored top-level fields an update may change, in the backend's spelling. */
export const EDITABLE_NODE_FIELDS = [
  'displayName', 'entityType', 'tags', 'description', 'qualifiedName', 'sourceSystem',
] as const

export type NodePayloadShape = Partial<Record<(typeof EDITABLE_NODE_FIELDS)[number], unknown>> & {
  /** Undefined when the source carried no bag at all (a partial snapshot), so a diff can tell
   *  "no properties" from "properties not recorded". */
  properties?: Bag
}

/** A canvas node's data (or an already-stored payload) in the backend's shape: only the fields an
 *  update can carry, with `properties` reduced to the user's own. */
export function toPayloadShape(data: unknown): NodePayloadShape {
  const d = asBag(data)
  const out: NodePayloadShape = {}
  for (const field of EDITABLE_NODE_FIELDS) {
    const canvas = CANVAS_KEY[field]
    if (field in d) out[field] = d[field]
    else if (canvas && canvas in d) out[field] = d[canvas]
  }
  if ('properties' in d) out.properties = userProperties(d.properties)
  return out
}

/** `data` (canvas shape) with a node patch applied: stored fields set under their canvas keys,
 *  `properties` merged with `unset` removed, and the business-label mirror kept in step. */
export function applyNodePatch(data: Bag, payload: Bag, unset: readonly string[] = []): Bag {
  const out: Bag = { ...data }
  for (const [field, value] of Object.entries(payload)) {
    if (field !== 'properties') out[CANVAS_KEY[field] ?? field] = value
  }
  const properties = { ...asBag(data.properties), ...asBag(payload.properties) }
  for (const k of unset) delete properties[k]
  out.properties = properties
  out.businessLabel = typeof properties.businessLabel === 'string' ? properties.businessLabel : undefined
  return out
}
