/**
 * fileRows — what a file holds, read in the browser, whichever of the two front doors it came
 * through:
 *
 *  - the simple files: a things CSV, a connections CSV, or one JSON file with `things` (and
 *    `connections`), as `components/playground/ownData.ts` reads them;
 *  - the standard import file: a `kind` column (CSV, TSV) or field (NDJSON, a JSON array) of
 *    `node` or `edge`, as an export writes it and the import templates carry it.
 *
 * Both read into one shape: things and connections as the simple files name them, and what they
 * hold by type. `toImportRows` writes them as the standard import's NDJSON, so the server only
 * ever reads the standard. An Excel workbook, or a standard file too large to read here, goes to
 * the server as it is (`format: 'server'`): the server reads it.
 */
import { caseFold } from '@/features/ontology/lib/caseFold'
import { detectFormat, type ImportFormat } from '@/services/importExportApiService'
import {
  connectionsFromCsv, guessConnectionColumns, guessThingColumns, looksLikeConnections, parseCsv,
  parseOwnDataJson, summarize, thingsFromCsv, validateOwnData,
  type CsvTable, type OwnConnection, type OwnThing, type PropertyValue, type RowError, type ThingColumns,
} from '@/components/playground/ownData'

/** `server`: read by the server alone (an Excel workbook, say), sent as it is. */
export type FileFormat = 'simple' | 'standard' | 'server'

export interface TypeSummary {
  /** Things and connections counted by type, most first. */
  thingTypes: [string, number][]
  connectionTypes: [string, number][]
  /** By connection type: the distinct pairs of thing types its rows join, as [from, to]. */
  connectionEnds: Record<string, [string, string][]>
}

export interface FileRead {
  format: FileFormat
  things: OwnThing[]
  connections: OwnConnection[]
  summary: TypeSummary
  /** The file to send as it is: one the server reads (`server`), or a standard file. */
  passthrough?: File
  /** Rows of the simple files that would be refused, and where they are. */
  errors: RowError[]
  /** A simple JSON file's own name and description, for what it makes. */
  name?: string
  description?: string
  /** A things CSV: its table and the columns its fields are read from, so its things can be read
   *  again by another identifier column (`withIdentifierColumn`). */
  keyedBy?: { file: string; table: CsvTable; columns: ThingColumns; connections?: { file: string; lines?: number[] } }
  /** A standard file read here: each node row's identifier, in file order — its urn, else its
   *  `prop.id`, else its entity_id; '' for a row that gives none. */
  identifiers?: string[]
  /** A standard file some of whose node rows give no identifier: its records, so one can be
   *  mapped from a column (`withIdentifierColumn`). Kept only then: a large file is held once. */
  records?: Record<string, unknown>[]
  /** The format of a `passthrough` made here (rewritten with identifiers), not the file chosen. */
  passthroughFormat?: ImportFormat
}

/** A file's type name → a type id of the data model; `null` leaves its rows out. A name not
 *  listed is sent as the file names it. */
export interface TypeMap {
  entity: Record<string, string | null>
  relationship: Record<string, string | null>
}

/** A type of a data model, as a match is made against it. */
export interface TypeRef {
  id: string
  name: string
}

/** Read whole in the browser up to this. A larger standard file goes to the server as it is. */
export const READ_LIMIT = 50 * 1024 ** 2

/** The property a Playground graph identifies its things by, kept equal to their urn (backend
 *  `playground_policy.IDENTITY_PROPERTY`): an import there needs a urn or one of these per thing. */
export const IDENTITY_PROPERTY = 'id'

/** Formats only the server reads (or refuses, saying why). */
const SERVER_ONLY = new Set(['xlsx', 'xlsm', 'xls', 'numbers', 'parquet', 'zip'])
/** The standard's own columns, beside `kind`. */
const STANDARD_COLUMNS = ['urn', 'entity_id', 'entityType', 'edgeType', 'displayName', 'sourceUrn', 'targetUrn']

/** A thing's urn: its key when that is one, else one made from it — as the server's `urn_of`. */
export function urnOf(key: string): string {
  return key.startsWith('urn:') ? key : `urn:playground:${key}`
}

type Rec = Record<string, unknown>
const extOf = (name: string) => /\.([a-z0-9]+)$/.exec(name.toLowerCase())?.[1] ?? ''
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())
const isKind = (v: unknown) => ['node', 'edge'].includes(str(v).toLowerCase())
const isRecord = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const standardHeader = (headers: string[]) => headers.includes('kind') && headers.some(h => STANDARD_COLUMNS.includes(h))

/** One file, read: a simple file holds `things`, `connections`, or (JSON) both; any other is a
 *  whole import on its own. */
interface Part {
  file: File
  format: FileFormat
  things?: OwnThing[]
  connections?: OwnConnection[]
  /** The CSV line each row starts on. */
  lines?: number[]
  name?: string
  description?: string
  /** A things CSV's table and the columns read from it. */
  table?: CsvTable
  columns?: ThingColumns
  /** A standard file's node rows' identifiers, and (when some give none) its records. */
  identifiers?: string[]
  records?: Rec[]
}

function propertiesOf(r: Rec): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {}
  for (const [k, v] of Object.entries(r)) {
    if (k.startsWith('prop.') && v != null && v !== '') out[k.slice('prop.'.length)] = v as PropertyValue
  }
  let overflow = r.properties_json
  if (typeof overflow === 'string') {
    try { overflow = overflow.trim() ? JSON.parse(overflow) : null } catch { overflow = null }
  }
  if (isRecord(overflow)) Object.assign(out, overflow)
  return out
}

/** Standard records as things and connections. A delete row is no thing to make, and is passed by. */
function fromStandard(records: Rec[]): { things: OwnThing[]; connections: OwnConnection[] } {
  const things: OwnThing[] = []
  const connections: OwnConnection[] = []
  for (const r of records) {
    if (str(r._op).toLowerCase() === 'delete') continue
    const kind = str(r.kind).toLowerCase()
    if (kind === 'node') {
      // Its id names it when it has no urn, as an import into the Playground reads it.
      const key = str(r.urn) || str(r.entity_id) || str(propertiesOf(r)[IDENTITY_PROPERTY])
      const thing: OwnThing = { key, type: str(r.entityType), name: str(r.displayName) || str(r.qualifiedName) || key }
      const description = str(r.description)
      if (description) thing.description = description
      const tags = (Array.isArray(r.tags) ? r.tags.map(str) : str(r.tags).split(',').map(t => t.trim())).filter(Boolean)
      if (tags.length) thing.tags = tags
      const properties = propertiesOf(r)
      if (Object.keys(properties).length) thing.properties = properties
      things.push(thing)
    } else if (kind === 'edge') {
      connections.push({
        from: str(r.sourceUrn) || str(r.source_entity_id),
        type: str(r.edgeType),
        to: str(r.targetUrn) || str(r.target_entity_id),
      })
    }
  }
  return { things, connections }
}

/** A standard node record's identifier: its urn, else its `prop.id`, else its entity_id ('' for
 *  none) — what an import into the Playground needs of every node row. */
export function standardIdentifier(r: Rec): string {
  return str(r.urn) || str(propertiesOf(r)[IDENTITY_PROPERTY]) || str(r.entity_id)
}

/** A standard file read here, as a part: its things and connections, each node row's identifier,
 *  and — only when one gives none — its records, for one to be mapped from a column. */
function standardPart(file: File, records: Rec[]): Part {
  const nodes = records.filter(r => str(r.kind).toLowerCase() === 'node' && str(r._op).toLowerCase() !== 'delete')
  const identifiers = nodes.map(standardIdentifier)
  return { file, format: 'standard', ...fromStandard(records), identifiers,
    ...(identifiers.some(id => !id) ? { records } : {}) }
}

/** A file too large to read here is standard when its first lines say so. */
async function looksStandard(file: File, format: ImportFormat): Promise<boolean> {
  const head = (await file.slice(0, 65536).text()).replace(/^﻿/, '')
  if (format === 'json' || format === 'ndjson') return /"kind"\s*:\s*"(node|edge)"/i.test(head)
  return standardHeader(parseCsv(head.split(/\r?\n/, 1)[0] ?? '').headers)
}

async function readOne(file: File): Promise<Part> {
  if (SERVER_ONLY.has(extOf(file.name))) return { file, format: 'server' }
  const format = await detectFormat(file)
  if (format === 'xlsx') return { file, format: 'server' }
  if (file.size > READ_LIMIT) {
    if (await looksStandard(file, format)) return { file, format: 'server' }
    throw new Error(`It’s over ${READ_LIMIT / 1024 ** 2} MB, too large to read here. Save it in the standard import `
      + 'format (start from a data model’s template): a file of that can be as large as you like.')
  }
  const text = (await file.text()).replace(/^﻿/, '')
  if (format === 'json') {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('This file isn’t JSON — check it opens in a text editor, or start from a template.')
    }
    const records = Array.isArray(data) ? data
      : isRecord(data) && !('things' in data) ? (data.records ?? data.rows ?? [data]) : null
    if (Array.isArray(records) && records.some(r => isRecord(r) && isKind(r.kind))) {
      return standardPart(file, records.filter(isRecord))
    }
    const simple = parseOwnDataJson(text)
    return { file, format: 'simple', things: simple.things, connections: simple.connections, name: simple.name, description: simple.description }
  }
  if (format === 'ndjson') {
    const records: Rec[] = []
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return
      let rec: unknown
      try {
        rec = JSON.parse(line)
      } catch {
        throw new Error(`Line ${i + 1} isn’t JSON.`)
      }
      if (isRecord(rec)) records.push(rec)
    })
    if (!records.some(r => isKind(r.kind))) throw new Error('None of its lines has a "kind" of node or edge — see the template.')
    return standardPart(file, records)
  }
  const table = parseCsv(text)
  if (!table.headers.length) throw new Error('This file is empty.')
  const kind = table.headers.indexOf('kind')
  if (standardHeader(table.headers) && table.rows.every(r => !str(r.cells[kind]) || isKind(r.cells[kind]))) {
    const records = table.rows.map(r => Object.fromEntries(table.headers.map((h, i) => [h, r.cells[i] ?? ''])))
    return standardPart(file, records)
  }
  const lines = table.rows.map(r => r.line)
  if (looksLikeConnections(table.headers)) {
    return { file, format: 'simple', connections: connectionsFromCsv(table, guessConnectionColumns(table.headers)), lines }
  }
  const columns = guessThingColumns(table.headers)
  return { file, format: 'simple', things: thingsFromCsv(table, columns), lines, table, columns }
}

/** Read one file, its problem said with its name. */
async function readNamed(file: File): Promise<Part> {
  try {
    return await readOne(file)
  } catch (e) {
    throw new Error(`${file.name}: ${e instanceof Error ? e.message : 'couldn’t be read.'}`)
  }
}

/** What one file holds, for a list that keeps one of each: a whole import (`whole`, on its own),
 *  things, connections, or both (a JSON file of the simple kind). Throws, naming the file, on one
 *  it can't read. */
export async function fileRole(file: File): Promise<'whole' | 'things' | 'connections' | 'both'> {
  const part = await readNamed(file)
  if (part.format !== 'simple') return 'whole'
  return part.things && part.connections ? 'both' : part.things ? 'things' : 'connections'
}

function summaryOf(things: OwnThing[], connections: OwnConnection[]): TypeSummary {
  const { thingTypes, connectionTypes } = summarize(things, connections)
  const typeOf = new Map(things.map(t => [t.key, t.type]))
  const ends = new Map<string, [string, string][]>()
  const seen = new Set<string>()
  for (const c of connections) {
    const from = typeOf.get(c.from)
    const to = typeOf.get(c.to)
    if (!c.type || !from || !to) continue
    const pair = JSON.stringify([c.type, from, to])
    if (seen.has(pair)) continue
    seen.add(pair)
    ends.set(c.type, [...(ends.get(c.type) ?? []), [from, to]])
  }
  return { thingTypes, connectionTypes, connectionEnds: Object.fromEntries(ends) }
}

/**
 * Read the files a person chose: one standard file or one the server reads, alone; or the simple
 * files — a things file and a connections file, or one JSON file of both. Throws, in plain words
 * naming the file, on one it can't read or a choice that doesn't go together.
 */
export async function readFiles(files: File[]): Promise<FileRead> {
  const parts: Part[] = []
  for (const f of files) parts.push(await readNamed(f))
  const whole = parts.find(p => p.format !== 'simple')
  if (whole) {
    if (parts.length > 1) throw new Error(`${whole.file.name} is a whole import on its own: choose it alone.`)
    const { things = [], connections = [], identifiers, records } = whole
    return { format: whole.format, things, connections, summary: summaryOf(things, connections), passthrough: whole.file, errors: [],
      ...(identifiers ? { identifiers } : {}), ...(records ? { records } : {}) }
  }
  const thingParts = parts.filter(p => p.things)
  const connectionParts = parts.filter(p => p.connections)
  for (const [list, what] of [[thingParts, 'things'], [connectionParts, 'connections']] as const) {
    if (list.length > 1) {
      throw new Error(`${list.map(p => p.file.name).join(' and ')} both hold ${what}: choose one file of things and one of connections.`)
    }
  }
  return simpleRead(thingParts[0], connectionParts[0])
}

/** The simple files' read: their things and connections, the rows that would be refused, and —
 *  for a things CSV — what to read them again by another identifier column with. */
function simpleRead(tp: Part | undefined, cp: Part | undefined): FileRead {
  const things = tp?.things ?? []
  const connections = cp?.connections ?? []
  const errors = validateOwnData(things, connections).rows.map((e): RowError => {
    const part = e.section === 'things' ? tp : cp
    const line = part?.lines?.[e.index]
    return { ...e, ...(part ? { file: part.file.name } : {}), ...(line ? { line } : {}) }
  })
  return {
    format: 'simple', things, connections, summary: summaryOf(things, connections), errors,
    ...(tp?.name ? { name: tp.name } : {}), ...(tp?.description ? { description: tp.description } : {}),
    ...(tp?.table && tp.columns ? { keyedBy: {
      file: tp.file.name, table: tp.table, columns: tp.columns,
      ...(cp ? { connections: { file: cp.file.name, ...(cp.lines ? { lines: cp.lines } : {}) } } : {}),
    } } : {}),
  }
}

/**
 * The read with its things identified by `column`: a things CSV's things read again with it as
 * their key (another field it held gives it up; the old key column becomes a property), its rows
 * checked again; or, for a standard file, each node row that gives no identifier given one from
 * `column`'s value — as its urn (`urnOf`), so it shows as the thing's `id` too — and the file to
 * send rewritten as NDJSON. Any other read, or a column it doesn't have, is returned as it is.
 */
export function withIdentifierColumn(read: FileRead, column: string): FileRead {
  const csv = read.keyedBy
  if (csv) {
    if (csv.columns.key === column || !csv.table.headers.includes(column)) return read
    const columns: ThingColumns = { ...csv.columns, key: column }
    for (const field of ['type', 'name', 'description', 'tags'] as const) if (columns[field] === column) columns[field] = null
    // An old key column named `id` isn't kept as a property: a thing's `id` is its identifier, so
    // the old values would name other things.
    const things = thingsFromCsv(csv.table, columns).map((t) => {
      if (!t.properties || !(IDENTITY_PROPERTY in t.properties)) return t
      const out: OwnThing = { ...t, properties: { ...t.properties } }
      delete out.properties![IDENTITY_PROPERTY]
      if (!Object.keys(out.properties!).length) delete out.properties
      return out
    })
    const tp: Part = { file: new File([], csv.file), format: 'simple', things,
      lines: csv.table.rows.map(r => r.line), table: csv.table, columns }
    const cp: Part | undefined = csv.connections && { file: new File([], csv.connections.file), format: 'simple',
      connections: read.connections, ...(csv.connections.lines ? { lines: csv.connections.lines } : {}) }
    return { ...simpleRead(tp, cp), ...(read.name ? { name: read.name } : {}), ...(read.description ? { description: read.description } : {}) }
  }
  if (!read.records || !read.passthrough) return read
  const records = read.records.map((r) => {
    if (str(r.kind).toLowerCase() !== 'node' || standardIdentifier(r)) return r
    const value = str(r[column])
    return value ? { ...r, urn: urnOf(value) } : r
  })
  const part = standardPart(read.passthrough, records)
  const name = `${read.passthrough.name.replace(/\.[^.]+$/, '')}.identified.ndjson`
  const lines = records.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '' && v != null))))
  return {
    ...read, things: part.things ?? [], connections: part.connections ?? [],
    summary: summaryOf(part.things ?? [], part.connections ?? []), identifiers: part.identifiers, records,
    passthrough: new File([`${lines.join('\n')}\n`], name, { type: 'application/x-ndjson', lastModified: read.passthrough.lastModified }),
    passthroughFormat: 'ndjson',
  }
}

/** Each of `names` as the type of `types` it names — by id, then by name, whatever the case —
 *  when one does. */
export function matchTypes(names: readonly string[], types: readonly TypeRef[]): Record<string, string> {
  const byId = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const t of types) {
    if (!byId.has(caseFold(t.id))) byId.set(caseFold(t.id), t.id)
    if (!byName.has(caseFold(t.name))) byName.set(caseFold(t.name), t.id)
  }
  const out: Record<string, string> = {}
  for (const name of names) {
    const hit = byId.get(caseFold(name)) ?? byName.get(caseFold(name))
    if (hit) out[name] = hit
  }
  return out
}

/** Where a row that would be refused is: "things.csv, line 4", or "example.json, thing 3". */
export function whereOf(e: RowError): string {
  const what = `${e.section === 'things' ? 'thing' : 'connection'} ${e.index + 1}`
  if (!e.file) return what
  return e.line ? `${e.file}, line ${e.line}` : `${e.file}, ${what}`
}

/**
 * The read as the standard import's NDJSON: a node row per thing (`urn` from its key, as
 * `urnOf`), then an edge row per connection, their types as `typeMap` maps them. A type mapped to
 * null leaves its rows out, and with a thing go the connections to it; a connection to a key no
 * thing in the file has (a thing already in the graph) is kept.
 */
export function toImportRows(read: FileRead, typeMap: TypeMap): string {
  const typeIn = (map: Record<string, string | null>, name: string) => (has(map, name) ? map[name] : name)
  const lines: string[] = []
  const keys = new Set(read.things.map(t => t.key))
  const kept = new Set<string>()
  for (const t of read.things) {
    const entityType = typeIn(typeMap.entity, t.type)
    if (entityType === null) continue
    kept.add(t.key)
    const row: Rec = { kind: 'node', urn: urnOf(t.key), entityType, displayName: t.name }
    if (t.description) row.description = t.description
    if (t.tags?.length) row.tags = t.tags
    for (const [k, v] of Object.entries(t.properties ?? {})) row[`prop.${k}`] = v
    lines.push(JSON.stringify(row))
  }
  const gone = (key: string) => keys.has(key) && !kept.has(key)
  for (const c of read.connections) {
    const edgeType = typeIn(typeMap.relationship, c.type)
    if (edgeType === null || gone(c.from) || gone(c.to)) continue
    lines.push(JSON.stringify({ kind: 'edge', edgeType, sourceUrn: urnOf(c.from), targetUrn: urnOf(c.to) }))
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}

/** `toImportRows` as one NDJSON file, named after the files it came from and dated as the latest
 *  of them: the same files, chosen again, make the same file — so its upload resumes. */
export function toImportFile(read: FileRead, typeMap: TypeMap, sources: readonly File[]): File {
  const name = `${sources.map(f => f.name.replace(/\.[^.]+$/, '')).join('+') || 'import'}.ndjson`
  const lastModified = Math.max(0, ...sources.map(f => f.lastModified))
  return new File([toImportRows(read, typeMap)], name, { type: 'application/x-ndjson', lastModified })
}
