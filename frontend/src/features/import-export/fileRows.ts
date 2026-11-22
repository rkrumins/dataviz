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
  type OwnConnection, type OwnThing, type PropertyValue, type RowError,
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
      const key = str(r.urn) || str(r.entity_id)
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
      return { file, format: 'standard', ...fromStandard(records.filter(isRecord)) }
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
    return { file, format: 'standard', ...fromStandard(records) }
  }
  const table = parseCsv(text)
  if (!table.headers.length) throw new Error('This file is empty.')
  const kind = table.headers.indexOf('kind')
  if (standardHeader(table.headers) && table.rows.every(r => !str(r.cells[kind]) || isKind(r.cells[kind]))) {
    const records = table.rows.map(r => Object.fromEntries(table.headers.map((h, i) => [h, r.cells[i] ?? ''])))
    return { file, format: 'standard', ...fromStandard(records) }
  }
  const lines = table.rows.map(r => r.line)
  return looksLikeConnections(table.headers)
    ? { file, format: 'simple', connections: connectionsFromCsv(table, guessConnectionColumns(table.headers)), lines }
    : { file, format: 'simple', things: thingsFromCsv(table, guessThingColumns(table.headers)), lines }
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
    const { things = [], connections = [] } = whole
    return { format: whole.format, things, connections, summary: summaryOf(things, connections), passthrough: whole.file, errors: [] }
  }
  const thingParts = parts.filter(p => p.things)
  const connectionParts = parts.filter(p => p.connections)
  for (const [list, what] of [[thingParts, 'things'], [connectionParts, 'connections']] as const) {
    if (list.length > 1) {
      throw new Error(`${list.map(p => p.file.name).join(' and ')} both hold ${what}: choose one file of things and one of connections.`)
    }
  }
  const [tp] = thingParts
  const [cp] = connectionParts
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
