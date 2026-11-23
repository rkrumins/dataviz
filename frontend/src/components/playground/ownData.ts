/**
 * The simple files, read in the browser: things — a key, a type, a name, and optionally a
 * description, properties and tags — and connections between their keys, as two CSV files or one
 * JSON file. People arrive with spreadsheets, so CSV is read here: quoted values may hold commas,
 * doubled quotes and line breaks, and a file Excel saved with semicolons or tabs reads the same.
 * Columns are matched to what a thing or a connection needs; every other column of things becomes
 * a property. `features/import-export/fileRows.ts` turns them into the standard import's rows.
 *
 * Every row that would be refused is named here first, so a person fixes their file before they
 * wait on an import.
 */

import { ancestryColumnsIn } from '@/lib/ancestryColumns'
import type { OwnConnection, OwnThing, PropertyValue } from '@/services/playgroundService'

export type { OwnConnection, OwnThing, PropertyValue }

/** `types`: the most kinds of thing (and of connection) a data model made from a file may have. */
export const OWN_DATA_LIMITS = {
    types: 50, name: 80, description: 4000, key: 200, type: 60, thingName: 200,
} as const

/** One row that would be refused, and (when read from a file) where it is. */
export interface RowError {
    section: 'things' | 'connections'
    index: number
    field: string
    message: string
    file?: string
    /** The line of a CSV file the row starts on. */
    line?: number
}

// ── CSV ─────────────────────────────────────────────────────────────

export interface CsvRow {
    cells: string[]
    /** The line of the file the row starts on (the header is line 1). */
    line: number
}

export interface CsvTable {
    headers: string[]
    rows: CsvRow[]
}

/** The delimiter of a file: whichever of comma, semicolon or tab its first line has most of. */
function delimiterOf(text: string): string {
    const end = text.search(/\r|\n/)
    const first = end < 0 ? text : text.slice(0, end)
    const count = (d: string) => first.split(d).length - 1
    return [';', '\t'].reduce((best, d) => (count(d) > count(best) ? d : best), ',')
}

/** RFC 4180, as spreadsheets write it. Blank lines are skipped; an unclosed quote throws, naming
 *  the line it opened on. */
export function parseCsv(input: string): CsvTable {
    const text = input.replace(/^\uFEFF/, '')
    const sep = delimiterOf(text)
    const records: CsvRow[] = []
    let cells: string[] = []
    let cell = ''
    let quoted = false
    let line = 1
    let start = 1
    let quoteLine = 0
    const endRecord = () => {
        cells.push(cell)
        if (cells.some(c => c.trim() !== '')) records.push({ cells, line: start })
        cells = []
        cell = ''
    }
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
            } else {
                if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++
                cell += ch
            }
        } else if (ch === '"' && cell === '') {
            quoted = true
            quoteLine = line
        } else if (ch === sep) {
            cells.push(cell)
            cell = ''
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++
            endRecord()
            line++
            start = line
        } else {
            cell += ch
        }
    }
    if (quoted) throw new Error(`A quoted value opened on line ${quoteLine} never closes — check for a missing ".`)
    if (cell !== '' || cells.length) endRecord()
    const [head, ...rows] = records
    return { headers: (head?.cells ?? []).map(h => h.trim()), rows }
}

/** Write rows as CSV, quoting what needs it. */
export function toCsv(rows: readonly (readonly string[])[]): string {
    const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    return rows.map(r => r.map(quote).join(',')).join('\n') + '\n'
}

// ── Columns ─────────────────────────────────────────────────────────

/** Which column holds each field (a header name), or null for none. */
export interface ThingColumns {
    key: string | null
    type: string | null
    name: string | null
    description: string | null
    tags: string | null
}

export interface ConnectionColumns {
    from: string | null
    type: string | null
    to: string | null
}

const THING_NAMES: Record<keyof ThingColumns, string[]> = {
    key: ['key', 'id', 'identifier', 'urn'],
    type: ['type', 'kind', 'entitytype', 'category'],
    name: ['name', 'label', 'title', 'displayname'],
    description: ['description', 'desc', 'about', 'summary'],
    tags: ['tags', 'tag'],
}
const CONNECTION_NAMES: Record<keyof ConnectionColumns, string[]> = {
    from: ['from', 'source', 'src', 'fromkey', 'sourcekey', 'upstream'],
    type: ['type', 'relationship', 'relation', 'kind', 'edgetype', 'label'],
    to: ['to', 'target', 'dst', 'destination', 'tokey', 'targetkey', 'downstream'],
}

const norm = (h: string) => h.toLowerCase().replace(/[\s_-]+/g, '')

function guess<K extends string>(headers: string[], names: Record<K, string[]>): Record<K, string | null> {
    const taken = new Set<string>()
    const out = {} as Record<K, string | null>
    for (const field of Object.keys(names) as K[]) {
        const hit = headers.find(h => !taken.has(h) && names[field].includes(norm(h))) ?? null
        if (hit) taken.add(hit)
        out[field] = hit
    }
    return out
}

export const guessThingColumns = (headers: string[]): ThingColumns => guess(headers, THING_NAMES)
export const guessConnectionColumns = (headers: string[]): ConnectionColumns => guess(headers, CONNECTION_NAMES)

/** A file whose columns say where a connection starts and ends. */
export function looksLikeConnections(headers: string[]): boolean {
    const c = guessConnectionColumns(headers)
    return !!c.from && !!c.to
}

/** The columns of things that become properties: every column not matched to a field, but where a
 *  thing sat in the graph its file was exported from (`lib/ancestryColumns`): informational, never
 *  a property of the thing. Only in a file one of our exports wrote: someone's own `path` column
 *  stays a property. */
export function propertyColumns(headers: string[], cols: ThingColumns): string[] {
    const used = new Set(Object.values(cols).filter(Boolean))
    const skipped = new Set(ancestryColumnsIn(headers))
    return headers.filter(h => h && !used.has(h) && !skipped.has(h))
}

/** A cell as a property value: a plain number or true/false as such, everything else as text. A
 *  leading zero is an identifier ("0012"), not a number. */
function valueOf(cell: string): PropertyValue {
    if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(cell)) return Number(cell)
    if (cell === 'true' || cell === 'false') return cell === 'true'
    return cell
}

export function thingsFromCsv(table: CsvTable, cols: ThingColumns): OwnThing[] {
    const at = (h: string | null) => (h ? table.headers.indexOf(h) : -1)
    const idx = { key: at(cols.key), type: at(cols.type), name: at(cols.name), description: at(cols.description), tags: at(cols.tags) }
    const props = propertyColumns(table.headers, cols).map(h => [h, table.headers.indexOf(h)] as const)
    return table.rows.map(({ cells }) => {
        const get = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '')
        const key = get(idx.key)
        const thing: OwnThing = { key, type: get(idx.type), name: get(idx.name) || key }
        const description = get(idx.description)
        if (description) thing.description = description
        const tags = get(idx.tags).split(/[;,|]/).map(t => t.trim()).filter(Boolean)
        if (tags.length) thing.tags = tags
        const properties: Record<string, PropertyValue> = {}
        for (const [h, i] of props) {
            const v = get(i)
            if (v) properties[h] = valueOf(v)
        }
        if (Object.keys(properties).length) thing.properties = properties
        return thing
    })
}

export function connectionsFromCsv(table: CsvTable, cols: ConnectionColumns): OwnConnection[] {
    const at = (h: string | null) => (h ? table.headers.indexOf(h) : -1)
    const idx = { from: at(cols.from), type: at(cols.type), to: at(cols.to) }
    return table.rows.map(({ cells }) => {
        const get = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '')
        return { from: get(idx.from), type: get(idx.type), to: get(idx.to) }
    })
}

// ── JSON ────────────────────────────────────────────────────────────

export interface OwnDataFile {
    name?: string
    description?: string
    things: OwnThing[]
    connections: OwnConnection[]
}

/** A JSON file in the shape the server takes. Throws, in plain words, on one it can't read. */
export function parseOwnDataJson(text: string): OwnDataFile {
    let data: unknown
    try {
        data = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
        throw new Error('This file isn’t JSON — check it opens in a text editor, or start from the JSON template.')
    }
    const obj = data as Partial<OwnDataFile> | null
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.things)) {
        throw new Error('A JSON file needs a "things" list — see the JSON template.')
    }
    if (obj.connections !== undefined && !Array.isArray(obj.connections)) {
        throw new Error('"connections" must be a list — see the JSON template.')
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
    const things = obj.things.map((t): OwnThing => {
        const row = (t ?? {}) as Partial<OwnThing>
        const key = str(row.key).trim()
        const thing: OwnThing = { key, type: str(row.type).trim(), name: str(row.name).trim() || key }
        if (row.description) thing.description = str(row.description)
        if (row.properties && typeof row.properties === 'object') thing.properties = row.properties
        if (Array.isArray(row.tags)) thing.tags = row.tags.map(str).filter(Boolean)
        return thing
    })
    const connections = (obj.connections ?? []).map((c): OwnConnection => {
        const row = (c ?? {}) as Partial<OwnConnection>
        return { from: str(row.from).trim(), type: str(row.type).trim(), to: str(row.to).trim() }
    })
    const out: OwnDataFile = { things, connections }
    if (typeof obj.name === 'string' && obj.name.trim()) out.name = obj.name.trim()
    if (typeof obj.description === 'string' && obj.description.trim()) out.description = obj.description.trim()
    return out
}

// ── Checks ──────────────────────────────────────────────────────────

/** What the server would refuse: `rows` named one by one, `issues` about the whole. */
export function validateOwnData(things: OwnThing[], connections: OwnConnection[]): { rows: RowError[]; issues: string[] } {
    const L = OWN_DATA_LIMITS
    const rows: RowError[] = []
    const issues: string[] = []
    if (things.length === 0) issues.push('Add at least one thing.')

    const keys = new Set<string>()
    things.forEach((t, index) => {
        const err = (field: string, message: string) => rows.push({ section: 'things', index, field, message })
        if (!t.key) err('key', 'Needs a key')
        else if (t.key.length > L.key) err('key', `The key is over ${L.key} characters`)
        else if (keys.has(t.key)) err('key', `Another thing already has the key “${t.key}”`)
        if (!t.type) err('type', 'Needs a type')
        else if (t.type.length > L.type) err('type', `The type is over ${L.type} characters`)
        if (t.name.length > L.thingName) err('name', `The name is over ${L.thingName} characters`)
        for (const [k, v] of Object.entries(t.properties ?? {})) {
            if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
                err('properties', `“${k}” must be text, a number, true or false`)
            }
        }
        if (t.key) keys.add(t.key)
    })
    connections.forEach((c, index) => {
        const err = (field: string, message: string) => rows.push({ section: 'connections', index, field, message })
        if (!c.from) err('from', 'Needs the key it starts from')
        else if (!keys.has(c.from)) err('from', `No thing has the key “${c.from}”`)
        if (!c.type) err('type', 'Needs a type')
        else if (c.type.length > L.type) err('type', `The type is over ${L.type} characters`)
        if (!c.to) err('to', 'Needs the key it goes to')
        else if (!keys.has(c.to)) err('to', `No thing has the key “${c.to}”`)
    })

    const { thingTypes, connectionTypes } = summarize(things, connections)
    if (thingTypes.length > L.types) issues.push(`${thingTypes.length} kinds of thing — the Playground takes up to ${L.types}.`)
    if (connectionTypes.length > L.types) issues.push(`${connectionTypes.length} kinds of connection — the Playground takes up to ${L.types}.`)
    return { rows, issues }
}

/** Things and connections counted by type, most first. */
export function summarize(things: OwnThing[], connections: OwnConnection[]) {
    const count = (types: string[]) => {
        const m = new Map<string, number>()
        for (const t of types) if (t) m.set(t, (m.get(t) ?? 0) + 1)
        return [...m.entries()].sort((a, b) => b[1] - a[1])
    }
    return { thingTypes: count(things.map(t => t.type)), connectionTypes: count(connections.map(c => c.type)) }
}

// ── Templates ───────────────────────────────────────────────────────

/** A small example: a coffee shop's sales, from the tills and the web shop to what the business
 *  reads. The CSV templates and the JSON template are this, written three ways. */
export const EXAMPLE: Required<Pick<OwnDataFile, 'name' | 'description'>> & OwnDataFile = {
    name: 'Coffee shop sales',
    description: 'Where the coffee shop’s sales figures come from: the tills and the web shop, through the warehouse, to the dashboard and the loyalty report.',
    things: [
        { key: 'pos', type: 'System', name: 'Point of sale', description: 'The tills in every shop, one record per sale', properties: { owner: 'Store operations' } },
        { key: 'web_shop', type: 'System', name: 'Web shop', description: 'Orders placed on the website', properties: { owner: 'Digital' } },
        { key: 'orders_raw', type: 'Table', name: 'Raw orders', description: 'Every order as it lands, card numbers included', tags: ['pii'], properties: { owner: 'Data engineering', rows: 182000 } },
        { key: 'customers', type: 'Table', name: 'Customers', description: 'One row per customer: name, email, loyalty tier', tags: ['pii'], properties: { owner: 'Data engineering', rows: 9400 } },
        { key: 'orders_clean', type: 'Table', name: 'Clean orders', description: 'Orders without duplicates, card numbers removed', tags: ['certified'], properties: { owner: 'Analytics engineering', rows: 179500 } },
        { key: 'daily_sales', type: 'Table', name: 'Daily sales', description: 'Sales per shop per day — the "official" figures', tags: ['certified'], properties: { owner: 'Analytics engineering', rows: 2190 } },
        { key: 'sales_dashboard', type: 'Dashboard', name: 'Sales dashboard', description: 'What the business reads every morning', properties: { owner: 'Finance' } },
        { key: 'loyalty_report', type: 'Report', name: 'Loyalty report, monthly', description: 'Who comes back, and how often', tags: ['pii'], properties: { owner: 'Marketing' } },
    ],
    connections: [
        { from: 'pos', type: 'FEEDS', to: 'orders_raw' },
        { from: 'web_shop', type: 'FEEDS', to: 'orders_raw' },
        { from: 'web_shop', type: 'FEEDS', to: 'customers' },
        { from: 'orders_raw', type: 'FEEDS', to: 'orders_clean' },
        { from: 'orders_clean', type: 'FEEDS', to: 'daily_sales' },
        { from: 'daily_sales', type: 'FEEDS', to: 'sales_dashboard' },
        { from: 'orders_clean', type: 'FEEDS', to: 'loyalty_report' },
        { from: 'customers', type: 'FEEDS', to: 'loyalty_report' },
    ],
}

const THINGS_CSV = toCsv([
    ['key', 'type', 'name', 'description', 'tags', 'owner', 'rows'],
    ...EXAMPLE.things.map(t => [
        t.key, t.type, t.name, t.description ?? '', (t.tags ?? []).join(';'),
        String(t.properties?.owner ?? ''), t.properties?.rows === undefined ? '' : String(t.properties.rows),
    ]),
])
const CONNECTIONS_CSV = toCsv([['from', 'type', 'to'], ...EXAMPLE.connections.map(c => [c.from, c.type, c.to])])

/** What the dialog offers to download — the same files as docs/examples/playground. */
export const TEMPLATE_FILES: Record<'things.csv' | 'connections.csv' | 'example.json', string> = {
    'things.csv': THINGS_CSV,
    'connections.csv': CONNECTIONS_CSV,
    'example.json': `${JSON.stringify(EXAMPLE, null, 2)}\n`,
}
