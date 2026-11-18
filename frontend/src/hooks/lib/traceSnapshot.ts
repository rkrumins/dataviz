/**
 * traceSnapshot — a trace's results, small enough to keep in the browser
 * (2026-11-18).
 *
 * A saved trace keeps what it found, not only how to ask again: re-exporting
 * it needs no walk, and opening it later can say what changed since. Fifty
 * thousand rows as plain objects are tens of megabytes; as COLUMNS — names and
 * urns once each, every repeated string (type, layer, path, edge type) in a
 * table and referenced by number, the seeds that reach a row as one bitmask —
 * and gzipped, they are a few. The bytes are what IndexedDB keeps: an
 * ArrayBuffer clones everywhere a Blob may not.
 *
 * Decoding is defensive: a snapshot is read back from storage another
 * version of this code may have written, so a wrong shape reads as "no
 * results" rather than a broken list.
 */
import type { TraceExportEdge, TraceExportRole, TraceExportRow } from './traceExport'

/** The most rows a snapshot holds; past it a trace is saved as its recipe. */
export const TRACE_SNAPSHOT_MAX_ROWS = 500_000

const ROLES: readonly TraceExportRole[] = ['seed', 'inside-seed', 'upstream', 'downstream', 'both']

export interface TraceSnapshotRecord {
  v: 1
  encoding: 'gzip' | 'none'
  bytes: ArrayBuffer
  rows: number
  edges: number
}

interface Columns {
  v: 1
  urns: string[]
  names: string[]
  types: [string[], number[]]
  roles: number[]
  hopsUp: (number | null)[]
  hopsDown: (number | null)[]
  layers: [string[], number[]]
  paths: [string[], number[]]
  seeds: string[]
  reached: number[]
  edges: number[]
  edgeTypes: [string[], number[]]
}

function dictionary(values: readonly string[]): [string[], number[]] {
  const table: string[] = []
  const at = new Map<string, number>()
  const idx = values.map((v) => {
    let n = at.get(v)
    if (n === undefined) { n = table.length; at.set(v, n); table.push(v) }
    return n
  })
  return [table, idx]
}

const PATH_SEP = '\u0000'
const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close() } })
  return new Response(source.pipeThrough(stream)).arrayBuffer()
}

export async function packTraceSnapshot(
  rows: readonly TraceExportRow[],
  edges: readonly TraceExportEdge[],
): Promise<TraceSnapshotRecord> {
  const seeds = [...new Set(rows.flatMap(r => r.reachedFrom))].slice(0, 31)
  const seedBit = new Map(seeds.map((s, i) => [s, 1 << i]))
  const row = new Map(rows.map((r, i) => [r.urn, i]))
  const kept = edges.filter(e => row.has(e.source) && row.has(e.target))
  const columns: Columns = {
    v: 1,
    urns: rows.map(r => r.urn),
    names: rows.map(r => r.name),
    types: dictionary(rows.map(r => r.type)),
    roles: rows.map(r => ROLES.indexOf(r.role)),
    hopsUp: rows.map(r => r.hopsUp),
    hopsDown: rows.map(r => r.hopsDown),
    layers: dictionary(rows.map(r => r.layer)),
    paths: dictionary(rows.map(r => r.path.join(PATH_SEP))),
    seeds,
    reached: rows.map(r => r.reachedFrom.reduce((m, s) => m | (seedBit.get(s) ?? 0), 0)),
    edges: kept.flatMap(e => [row.get(e.source)!, row.get(e.target)!]),
    edgeTypes: dictionary(kept.map(e => e.type ?? '')),
  }
  const raw = new TextEncoder().encode(JSON.stringify(columns))
  if (canCompress()) {
    return { v: 1, encoding: 'gzip', bytes: await pipe(raw, new CompressionStream('gzip')), rows: rows.length, edges: kept.length }
  }
  return { v: 1, encoding: 'none', bytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer, rows: rows.length, edges: kept.length }
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && v.every(n => typeof n === 'number')
const isDict = (v: unknown, n: number): v is [string[], number[]] =>
  Array.isArray(v) && v.length === 2 && isStrings(v[0]) && isNumbers(v[1]) && v[1].length === n

/** The rows and edges back, or null when the record is not one this code can read. */
export async function unpackTraceSnapshot(
  record: unknown,
): Promise<{ rows: TraceExportRow[]; edges: TraceExportEdge[] } | null> {
  try {
    const r = record as Partial<TraceSnapshotRecord> | null
    // By tag, not `instanceof`: a buffer read back from IndexedDB may come
    // from another realm.
    if (!r || r.v !== 1 || Object.prototype.toString.call(r.bytes) !== '[object ArrayBuffer]') return null
    let bytes = new Uint8Array(r.bytes as ArrayBuffer)
    if (r.encoding === 'gzip') {
      if (!canCompress()) return null
      bytes = new Uint8Array(await pipe(bytes, new DecompressionStream('gzip')))
    } else if (r.encoding !== 'none') return null
    const c = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Columns>
    const n = c.urns?.length ?? -1
    if (c.v !== 1 || !isStrings(c.urns) || !isStrings(c.names) || c.names.length !== n) return null
    if (!isDict(c.types, n) || !isDict(c.layers, n) || !isDict(c.paths, n) || !isStrings(c.seeds)) return null
    if (!isNumbers(c.roles) || !isNumbers(c.reached) || !isNumbers(c.edges) || !Array.isArray(c.hopsUp) || !Array.isArray(c.hopsDown)) return null
    const [types, typeAt] = c.types
    const [layers, layerAt] = c.layers
    const [paths, pathAt] = c.paths
    const seeds = c.seeds
    const rows: TraceExportRow[] = c.urns.map((urn, i) => {
      const hopsUp = c.hopsUp![i] ?? null
      const hopsDown = c.hopsDown![i] ?? null
      const sides = [hopsUp, hopsDown].filter((h): h is number => typeof h === 'number')
      const path = paths[pathAt[i]!] ?? ''
      return {
        urn,
        name: c.names![i]!,
        type: types[typeAt[i]!] ?? '',
        role: ROLES[c.roles![i]!] ?? 'upstream',
        hops: sides.length > 0 ? Math.min(...sides) : null,
        hopsUp,
        hopsDown,
        layer: layers[layerAt[i]!] ?? '',
        path: path === '' ? [] : path.split(PATH_SEP),
        reachedFrom: seeds.filter((_, b) => (c.reached![i]! & (1 << b)) !== 0),
      }
    })
    const [edgeTypes, edgeTypeAt] = isDict(c.edgeTypes, c.edges.length / 2) ? c.edgeTypes : [[], []]
    const edges: TraceExportEdge[] = []
    for (let e = 0; e + 1 < c.edges.length; e += 2) {
      const source = rows[c.edges[e]!]?.urn
      const target = rows[c.edges[e + 1]!]?.urn
      if (!source || !target) continue
      edges.push({ source, target, type: edgeTypes[edgeTypeAt[e / 2]!] || null })
    }
    return { rows, edges }
  } catch {
    return null
  }
}
