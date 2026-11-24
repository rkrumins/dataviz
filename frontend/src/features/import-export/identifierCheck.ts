/**
 * identifierCheck — whether every thing a file holds has an identifier of its own, and no two share
 * one: what an import into the Playground needs (backend `resolve.resolve_rows`, "Needs an
 * identifier (urn or id)"), said before anything is sent.
 *
 * A thing's identifier is how its connections name it and how the next file finds it again. It
 * is read from a things CSV's key column (guessed from its name: `key`, `id`, `identifier`,
 * `urn`), a JSON file's `key`, or a standard file's `urn`, else its `prop.id`, else its
 * `entity_id`. A standard file whose node rows give none may take one from a column
 * (`fileRows.withIdentifierColumn`); a file the server reads is checked there as it loads. Where an
 * exported row sat (`lib/ancestryColumns`) is never offered as one: it names the row's container.
 */
import { ancestryColumnsIn } from '@/lib/ancestryColumns'
import { IDENTITY_PROPERTY, type FileRead } from './fileRows'

export interface IdentifierCheck {
  /** Where the identifiers are read from: a things CSV's `column` (choosable), a JSON file's
   *  `key`, a `standard` file's urn or id (a column may be mapped to rows that give neither), or
   *  the `server`, which reads the file — not checked here. */
  from: 'column' | 'key' | 'standard' | 'server'
  /** The column they are read from now: the things CSV's, or the one mapped onto a standard
   *  file's rows. */
  column: string | null
  /** The columns they could be read from instead. */
  columns: string[]
  total: number
  /** Things that have none. */
  blank: number
  /** The values more than one thing has, most first, and on how many each is. */
  duplicates: { value: string; count: number }[]
  /** The first identifiers, for a glance at what they look like. */
  sample: string[]
  /** Every thing has one, and no two share one (a file of connections alone has none to give). */
  ok: boolean
}

/** A standard file's own columns, which say what a row is rather than identify it. */
const STRUCTURAL = new Set([
  'kind', '_op', 'urn', 'entity_id', 'baseVersion', 'entityType', 'edgeType', 'description', 'tags',
  'sourceUrn', 'targetUrn', 'source_entity_id', 'target_entity_id', 'sourceQualifiedName',
  'targetQualifiedName', 'confidence', 'properties_json', 'layerAssignment', 'sourceSystem',
  `prop.${IDENTITY_PROPERTY}`,
])
const SAMPLE = 5

function tally(values: readonly string[]) {
  const counts = new Map<string, number>()
  let blank = 0
  for (const v of values) {
    if (!v) blank++
    else counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  const duplicates = [...counts].filter(([, c]) => c > 1).map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
  return { blank, duplicates }
}

/** The columns a standard file's node rows could take an identifier from: any of theirs that
 *  isn't one of the standard's own. */
function standardColumns(read: FileRead): string[] {
  const seen = new Set<string>()
  for (const r of read.records ?? []) {
    if (String(r.kind ?? '').trim().toLowerCase() !== 'node') continue
    for (const k of Object.keys(r)) if (!STRUCTURAL.has(k) && !/^(source|target)\./.test(k)) seen.add(k)
  }
  for (const k of ancestryColumnsIn([...seen])) seen.delete(k)
  return [...seen].sort((a, b) => Number(b === 'qualifiedName') - Number(a === 'qualifiedName') || a.localeCompare(b))
}

/** `read`'s things' identifiers, checked. `mapped`: the column mapped onto a standard file's rows
 *  that gave none, when one is. */
export function checkIdentifiers(read: FileRead, mapped: string | null = null): IdentifierCheck {
  if (read.format === 'server') {
    return { from: 'server', column: null, columns: [], total: 0, blank: 0, duplicates: [], sample: [], ok: true }
  }
  const values = read.format === 'standard' ? (read.identifiers ?? read.things.map(t => t.key)) : read.things.map(t => t.key)
  const { blank, duplicates } = tally(values)
  const csv = read.keyedBy
  const placed = new Set(csv ? ancestryColumnsIn(csv.table.headers) : [])
  return {
    from: csv ? 'column' : read.format === 'standard' ? 'standard' : 'key',
    column: csv ? csv.columns.key : mapped,
    columns: csv ? csv.table.headers.filter(h => h && h !== csv.columns.type && !placed.has(h)) : standardColumns(read),
    total: values.length, blank, duplicates,
    sample: values.filter(Boolean).slice(0, SAMPLE),
    ok: blank === 0 && duplicates.length === 0,
  }
}
