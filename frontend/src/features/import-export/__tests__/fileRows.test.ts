/**
 * fileRows pins:
 *   - the simple files read as things and connections: a things CSV and a connections CSV
 *     together, or one JSON file, with its name and description; rows that would be refused are
 *     named by file and line;
 *   - the standard file reads by its `kind`, in CSV, NDJSON or a JSON array: `urn ?? entity_id` is
 *     the key, `displayName ?? qualifiedName ?? key` the name, `prop.*` and `properties_json` the
 *     properties, `sourceUrn ?? source_entity_id` and `targetUrn ?? target_entity_id` the ends;
 *   - where an exported entity sat (its parent and path) is never a property, in either kind of file:
 *     every file an export or download writes, in every format read here, reads exactly as the same
 *     file without those columns — the same things, connections, identifiers and rows to import —
 *     and someone's own `path` column, in a file no export wrote, stays theirs;
 *   - a summary by type, with the distinct pairs of thing types each connection type joins;
 *   - an Excel workbook, and a standard file too large to read here, go to the server as they are;
 *   - toImportRows writes the standard's NDJSON with its types mapped, a type mapped to null
 *     leaving its rows out and the connections to them; urnOf is the server's urn_of;
 *   - types are matched by id, then by name, whatever the case.
 */
import { describe, expect, it } from 'vitest'
import { TEMPLATE_FILES } from '@/components/playground/ownData'
import { ANCESTRY_COLUMNS, PATH_SEPARATOR, URN_LIST_SEPARATOR } from '@/lib/ancestryColumns'
import { csvLine } from '@/lib/csv'
import { TRACE_EXPORT_COLUMNS } from '@/hooks/lib/traceExport'
import { matchTypes, readFiles, READ_LIMIT, toImportFile, toImportRows, urnOf, whereOf, type FileRead } from '../fileRows'
import { checkIdentifiers } from '../identifierCheck'

const file = (name: string, body: string, lastModified = 1000) => new File([body], name, { lastModified })
const lines = (ndjson: string) => ndjson.trim().split('\n').map((l) => JSON.parse(l))

const THINGS = 'key,type,name,owner\norders,Table,Orders,Data\ndaily,Table,Daily sales,\ndash,Dashboard,Sales dashboard,Finance\n'
const CONNECTIONS = 'from,type,to\norders,FEEDS,daily\ndaily,FEEDS,dash\n'

describe('urnOf', () => {
  it('keeps a key that is a urn, and makes one of any other, as the server does', () => {
    expect(urnOf('urn:li:dataset:orders')).toBe('urn:li:dataset:orders')
    expect(urnOf('orders')).toBe('urn:playground:orders')
  })
})

describe('readFiles: the simple files', () => {
  it('reads a things CSV and a connections CSV together, and sums them up by type', async () => {
    const read = await readFiles([file('things.csv', THINGS), file('links.csv', CONNECTIONS)])
    expect(read.format).toBe('simple')
    expect(read.things.map((t) => t.key)).toEqual(['orders', 'daily', 'dash'])
    expect(read.things[0]).toEqual({ key: 'orders', type: 'Table', name: 'Orders', properties: { owner: 'Data' } })
    expect(read.connections).toEqual([{ from: 'orders', type: 'FEEDS', to: 'daily' }, { from: 'daily', type: 'FEEDS', to: 'dash' }])
    expect(read.summary).toEqual({
      thingTypes: [['Table', 2], ['Dashboard', 1]],
      connectionTypes: [['FEEDS', 2]],
      connectionEnds: { FEEDS: [['Table', 'Table'], ['Table', 'Dashboard']] },
    })
    expect(read.errors).toEqual([])
    expect(read.passthrough).toBeUndefined()
  })

  it('reads the JSON template, with its own name and description', async () => {
    const read = await readFiles([file('example.json', TEMPLATE_FILES['example.json'])])
    expect(read.format).toBe('simple')
    expect(read.things).toHaveLength(8)
    expect(read.connections).toHaveLength(8)
    expect(read.name).toBe('Coffee shop sales')
    expect(read.description).toMatch(/coffee shop/)
  })

  it('names each row that would be refused by its file and line', async () => {
    const read = await readFiles([file('things.csv', THINGS), file('connections.csv', `${CONNECTIONS}daily,FEEDS,nowhere\n`)])
    expect(read.errors).toEqual([{ section: 'connections', index: 2, field: 'to', message: 'No thing has the key “nowhere”',
      file: 'connections.csv', line: 4 }])
    expect(whereOf(read.errors[0])).toBe('connections.csv, line 4')
  })

  it('says, naming the files, when two hold the same kind of rows', async () => {
    await expect(readFiles([file('a.csv', THINGS), file('b.csv', THINGS)])).rejects.toThrow(/a\.csv and b\.csv both hold things/)
  })

  it('says which file it can’t read', async () => {
    await expect(readFiles([file('broken.csv', 'from,type,to\n"never closed,FEEDS,b')])).rejects.toThrow(/^broken\.csv: A quoted value opened on line 2/)
  })
})

describe('readFiles: the standard file', () => {
  const STANDARD_CSV = [
    'kind,urn,entity_id,entityType,displayName,qualifiedName,prop.owner,properties_json,edgeType,sourceUrn,targetUrn,source_entity_id,target_entity_id',
    'node,urn:li:orders,,Table,Orders,,Data,"{""rows"": 12}",,,,,',
    'node,,ent_daily,Table,,db.daily,,,,,,,',
    'node,urn:li:dash,,Dashboard,,,,,,,,,',
    'edge,,,,,,,,FEEDS,urn:li:orders,,,ent_daily',
    'edge,,,,,,,,FEEDS,,urn:li:dash,ent_daily,',
  ].join('\n')

  it('reads a kind column: keys, names, properties and ends as the standard names them', async () => {
    const f = file('export.csv', STANDARD_CSV)
    const read = await readFiles([f])
    expect(read.format).toBe('standard')
    expect(read.passthrough).toBe(f)
    expect(read.things).toEqual([
      { key: 'urn:li:orders', type: 'Table', name: 'Orders', properties: { owner: 'Data', rows: 12 } },
      { key: 'ent_daily', type: 'Table', name: 'db.daily' },
      { key: 'urn:li:dash', type: 'Dashboard', name: 'urn:li:dash' },
    ])
    expect(read.connections).toEqual([
      { from: 'urn:li:orders', type: 'FEEDS', to: 'ent_daily' },
      { from: 'ent_daily', type: 'FEEDS', to: 'urn:li:dash' },
    ])
    expect(read.summary.connectionEnds).toEqual({ FEEDS: [['Table', 'Table'], ['Table', 'Dashboard']] })
  })

  it('reads NDJSON and a JSON array by their records’ kind, passing deletes by', async () => {
    const ndjson = [
      { kind: 'node', urn: 'urn:a', entityType: 'Table', displayName: 'A', tags: ['pii'] },
      { kind: 'node', entity_id: 'e1', _op: 'delete' },
      { kind: 'edge', edgeType: 'FEEDS', sourceUrn: 'urn:a', targetUrn: 'urn:b' },
    ].map((r) => JSON.stringify(r)).join('\n')
    const fromLines = await readFiles([file('rows.ndjson', ndjson)])
    expect(fromLines.format).toBe('standard')
    expect(fromLines.things).toEqual([{ key: 'urn:a', type: 'Table', name: 'A', tags: ['pii'] }])
    expect(fromLines.connections).toEqual([{ from: 'urn:a', type: 'FEEDS', to: 'urn:b' }])

    const fromArray = await readFiles([file('rows.json', JSON.stringify([{ kind: 'NODE', urn: 'urn:a', entityType: 'Table' }]))])
    expect(fromArray.format).toBe('standard')
    expect(fromArray.things[0]).toMatchObject({ key: 'urn:a', type: 'Table' })
  })

  it('takes a standard file alone', async () => {
    await expect(readFiles([file('export.csv', STANDARD_CSV), file('links.csv', CONNECTIONS)]))
      .rejects.toThrow(/export\.csv is a whole import on its own/)
  })
})

describe('readFiles: what the server reads', () => {
  it('sends an Excel workbook as it is, without reading it', async () => {
    const xlsx = file('book.xlsx', 'PK\u0003\u0004 not really a workbook')
    const read = await readFiles([xlsx])
    expect(read).toMatchObject({ format: 'server', things: [], connections: [], passthrough: xlsx, errors: [] })
  })

  it('sends a standard file too large to read here as it is, by its first line', async () => {
    const big = file('huge.csv', 'kind,urn,entityType\nnode,urn:a,Table\n')
    Object.defineProperty(big, 'size', { value: READ_LIMIT + 1 })
    expect(await readFiles([big])).toMatchObject({ format: 'server', passthrough: big })
    const simple = file('huge-things.csv', THINGS)
    Object.defineProperty(simple, 'size', { value: READ_LIMIT + 1 })
    await expect(readFiles([simple])).rejects.toThrow(/too large to read here/)
  })
})

describe('toImportRows', () => {
  it('writes the standard rows, its types mapped, things first', async () => {
    const read = await readFiles([file('things.csv', THINGS), file('links.csv', CONNECTIONS)])
    const rows = lines(toImportRows(read, { entity: { Table: 'dataset', Dashboard: 'dashboard' }, relationship: { FEEDS: 'PRODUCES' } }))
    expect(rows[0]).toEqual({ kind: 'node', urn: 'urn:playground:orders', entityType: 'dataset', displayName: 'Orders', 'prop.owner': 'Data' })
    expect(rows.map((r) => r.kind)).toEqual(['node', 'node', 'node', 'edge', 'edge'])
    expect(rows[3]).toEqual({ kind: 'edge', edgeType: 'PRODUCES', sourceUrn: 'urn:playground:orders', targetUrn: 'urn:playground:daily' })
  })

  it('leaves out a type mapped to null, and the connections to its things', async () => {
    const read = await readFiles([file('things.csv', THINGS), file('links.csv', CONNECTIONS)])
    const rows = lines(toImportRows(read, { entity: { Dashboard: null }, relationship: {} }))
    expect(rows.filter((r) => r.kind === 'node').map((r) => r.urn)).toEqual(['urn:playground:orders', 'urn:playground:daily'])
    // daily → dash goes with dash; a type not mapped is sent as the file names it.
    expect(rows.filter((r) => r.kind === 'edge')).toEqual([
      { kind: 'edge', edgeType: 'FEEDS', sourceUrn: 'urn:playground:orders', targetUrn: 'urn:playground:daily' }])
    expect(lines(toImportRows(read, { entity: {}, relationship: { FEEDS: null } })).every((r) => r.kind === 'node')).toBe(true)
  })

  it('keeps a connection to a thing already in the graph', async () => {
    const read = await readFiles([file('links.csv', 'from,type,to\nurn:li:orders,FEEDS,daily\n')])
    expect(lines(toImportRows(read, { entity: {}, relationship: {} }))).toEqual([
      { kind: 'edge', edgeType: 'FEEDS', sourceUrn: 'urn:li:orders', targetUrn: 'urn:playground:daily' }])
  })

  it('as a file, is named and dated after its sources, so the same files make the same upload', async () => {
    const sources = [file('things.csv', THINGS, 5000), file('links.csv', CONNECTIONS, 7000)]
    const read = await readFiles(sources)
    const map = { entity: {}, relationship: {} }
    const a = toImportFile(read, map, sources)
    const b = toImportFile(read, map, sources)
    expect(a.name).toBe('things+links.ndjson')
    expect(a.lastModified).toBe(7000)
    expect([a.size, a.lastModified, a.name]).toEqual([b.size, b.lastModified, b.name])
    expect(await a.text()).toBe(toImportRows(read, map))
  })
})

describe('matchTypes', () => {
  it('finds each name by id, then by name, whatever the case — and leaves out what it can’t find', () => {
    const types = [{ id: 'warehouseTable', name: 'Table' }, { id: 'table', name: 'Raw table' }, { id: 'dashboard', name: 'Dashboard' }]
    expect(matchTypes(['TABLE', 'warehousetable', 'dashboard', 'Report'], types))
      .toEqual({ TABLE: 'table', warehousetable: 'warehouseTable', dashboard: 'dashboard' })
    expect(matchTypes(['raw TABLE'], types)).toEqual({ 'raw TABLE': 'table' })
  })
})

describe('readFiles: a file that says where each entity sat, and the same file without', () => {
  type Row = Record<string, unknown>
  const PLACED = { parentUrn: 'urn:db', parentName: 'Warehouse', parentType: 'Database',
    path: ['Warehouse', 'gold'], pathUrns: ['urn:db', 'urn:gold'] }
  const TOP = { parentUrn: null, parentName: null, parentType: null, path: [], pathUrns: [] }
  const without = (rows: Row[]) => rows.map((r) => Object.fromEntries(
    Object.entries(r).filter(([k]) => !(ANCESTRY_COLUMNS as readonly string[]).includes(k))))

  /** `rows` as a file of `format`, as the exports write one: a list in a text cell as its text
   *  (a path `A / B`, its URNs `a; b`, tags `a, b`), no value an empty cell. */
  function written(format: string, rows: Row[], columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]): string {
    if (format === 'ndjson') return `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
    if (format === 'json') return JSON.stringify(rows)
    const cell = (k: string, v: unknown) => (v == null ? '' : Array.isArray(v)
      ? v.join(k === 'path' ? PATH_SEPARATOR : k === 'pathUrns' ? URN_LIST_SEPARATOR : ', ') : String(v))
    if (format === 'tsv') return [columns, ...rows.map((r) => columns.map((c) => cell(c, r[c])))].map((l) => l.join('\t')).join('\n')
    return [csvLine(columns), ...rows.map((r) => csvLine(columns.map((c) => cell(c, r[c]))))].join('')
  }

  /** What an import takes from a read file: everything but the file itself. A standard file's
   *  records, kept to map an identifier onto its rows, are its own and go to the server as they
   *  are, which reads none of the five. */
  const taken = (read: FileRead) => ({
    format: read.format, things: read.things, connections: read.connections, summary: read.summary,
    errors: read.errors, identifiers: read.identifiers, records: read.records ? without(read.records) : undefined,
    rows: toImportRows(read, { entity: {}, relationship: {} }), identifier: checkIdentifiers(read),
  })

  async function both(format: string, rows: Row[], columns?: string[]) {
    const plainColumns = columns?.filter((c) => !(ANCESTRY_COLUMNS as readonly string[]).includes(c))
    const placed = await readFiles([new File([written(format, rows, columns)], `placed.${format}`)])
    const plain = await readFiles([new File([written(format, without(rows), plainColumns)], `plain.${format}`)])
    return { placed, plain }
  }

  // A data source's export: node rows that say where they sit, and edge rows that never do.
  const EXPORT: Row[] = [
    { kind: 'node', entity_id: 'e1', urn: 'urn:t1', entityType: 'Table', displayName: 'orders', tags: ['pii', 'gold'],
      'prop.owner': 'Ops', baseVersion: 'h1', _op: '', ...PLACED },
    { kind: 'node', entity_id: 'e2', urn: 'urn:db', entityType: 'Database', displayName: 'Warehouse', baseVersion: 'h2', _op: '', ...TOP },
    { kind: 'edge', entity_id: 'x1', edgeType: 'CONTAINS', sourceUrn: 'urn:db', targetUrn: 'urn:t1', baseVersion: 'h3', _op: '' },
  ]

  it.each(['csv', 'tsv', 'ndjson', 'json'])('a data source’s %s export', async (format) => {
    const { placed, plain } = await both(format, EXPORT)
    expect(placed.format).toBe('standard')
    expect(taken(placed)).toEqual(taken(plain))
    expect(placed.things[0]).toEqual({ key: 'urn:t1', type: 'Table', name: 'orders', tags: ['pii', 'gold'], properties: { owner: 'Ops' } })
  })

  it.each(['csv', 'tsv', 'ndjson', 'json'])('a %s edge file that says where its edges sit anyway', async (format) => {
    const edges = [{ kind: 'edge', edgeType: 'FEEDS', sourceUrn: 'urn:t1', targetUrn: 'urn:t2', ...PLACED }]
    const { placed, plain } = await both(format, edges)
    expect(taken(placed)).toEqual(taken(plain))
    expect(placed.connections).toEqual([{ from: 'urn:t1', type: 'FEEDS', to: 'urn:t2' }])
  })

  it.each(['csv', 'tsv', 'ndjson', 'json'])('a %s file whose rows take their identifier from a column', async (format) => {
    // Rows with no urn or id of their own: the columns offered are the file's own, never where a row sat.
    const rows = [{ kind: 'node', entityType: 'Table', displayName: 'orders', qualifiedName: 'db.orders', ...PLACED }]
    const { placed, plain } = await both(format, rows)
    expect(taken(placed)).toEqual(taken(plain))
    expect(checkIdentifiers(placed).columns).toEqual(['qualifiedName', 'displayName'])
  })

  // The downloads, read as the simple files they are: a thing a row, every other column a property.
  const TRACE: Row[] = [{ urn: 'urn:t1', name: 'orders', type: 'Table', role: 'seed', hops: 0, hopsUp: '', hopsDown: '',
    layer: 'Gold', ...PLACED, reachedFrom: '' }]
  const MEMBERS: Row[] = [{ urn: 'urn:t1', name: 'orders', type: 'Table', qualifiedName: 'db.orders', via: 'seed', hops: '',
    hopsUp: 0, hopsDown: '', nearestSeed: 'urn:t1', ...PLACED }]
  const MATCHES: Row[] = [{ urn: 'urn:t1', displayName: 'orders', entityType: 'Table', qualifiedName: 'db.orders', ...PLACED,
    description: 'Every order', tags: 'pii' }]

  it.each([
    ['the trace dock’s CSV', TRACE, [...TRACE_EXPORT_COLUMNS]],
    ['a lineage download’s CSV', MEMBERS, undefined],
    ['a search’s CSV', MATCHES, undefined],
  ])('%s', async (_name, rows, columns) => {
    const { placed, plain } = await both('csv', rows, columns)
    expect(placed.format).toBe('simple')
    expect(taken(placed)).toEqual(taken(plain))
    expect(Object.keys(placed.things[0].properties ?? {}).some((k) => (ANCESTRY_COLUMNS as readonly string[]).includes(k))).toBe(false)
  })

  it.each([
    ['a lineage download’s NDJSON', 'ndjson', MEMBERS, /None of its lines has a "kind"/],
    ['a lineage download’s JSON', 'json', [{ meta: {}, nodes: MEMBERS, edges: [] }], /needs a "things" list/],
    ['a search’s NDJSON', 'ndjson', MATCHES, /None of its lines has a "kind"/],
  ])('%s is no import file, with them or without', async (_name, format, rows, refusal) => {
    const plainRows = format === 'json' ? [{ meta: {}, nodes: without(MEMBERS), edges: [] }] : without(rows as Row[])
    await expect(readFiles([new File([written(format as string, rows as Row[])], `placed.${format}`)])).rejects.toThrow(refusal)
    await expect(readFiles([new File([written(format as string, plainRows)], `plain.${format}`)])).rejects.toThrow(refusal)
  })

  it('keeps someone’s own path and parentName as properties: no export wrote their file', async () => {
    const read = await readFiles([new File(['key,type,name,path,parentName\na,Table,A,/data/a.csv,Ops\n'], 'mine.csv')])
    expect(read.things[0].properties).toEqual({ path: '/data/a.csv', parentName: 'Ops' })
  })
})
