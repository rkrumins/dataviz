/**
 * nativeCells — the values a native query answers with, as the server sends
 * them (``services/native_query/cells``): a plain string, number, true/false
 * or null stays itself; anything else is an object with a ``kind``.
 */

export interface NodeCell {
    kind: 'node'
    id: string
    labels: string[]
    urn: string | null
    displayName: string | null
    properties: Record<string, NativeCell>
    truncated?: boolean
}

export interface EdgeCell {
    kind: 'edge'
    id: string
    type: string
    start: string
    end: string
    properties: Record<string, NativeCell>
    truncated?: boolean
}

export interface PathCell {
    kind: 'path'
    nodes: NodeCell[]
    edges: EdgeCell[]
    truncated?: boolean
    size?: number
}

export interface MapCell {
    kind: 'map'
    entries: Record<string, NativeCell>
    truncated?: boolean
    size?: number
}

export interface ListCell {
    kind: 'list'
    items: NativeCell[]
    truncated?: boolean
    size?: number
}

export type NativeCell =
    | string | number | boolean | null
    | NodeCell | EdgeCell | PathCell | MapCell | ListCell
    | { kind: 'temporal'; type: string; text: string }
    | { kind: 'point'; srid: number; coordinates: number[] }
    | { kind: 'bytes'; length: number }
    | { kind: 'number'; text: string }
    | { kind: 'string'; text: string; length: number; truncated: true }
    | { kind: 'truncated' }


/** Whether a column holds urns by its name: ``urn``, ``n.urn``. */
function urnColumn(name: string): boolean {
    return /(^|\.)`?urn`?$/i.test(name.trim())
}


/** Every entity urn an answer names, in order, once: the urn of each node
 *  (in a path, a list or a map too), and each value in a column named for
 *  urns — what "Highlight on canvas" lights up. */
export function urnsOf(columns: string[], rows: unknown[][]): string[] {
    const seen = new Set<string>()
    const add = (urn: unknown) => {
        if (typeof urn === 'string' && urn) seen.add(urn)
    }
    const visit = (cell: unknown, depth: number) => {
        if (!cell || typeof cell !== 'object' || depth > 4) return
        const c = cell as { kind?: string }
        if (c.kind === 'node') add((c as NodeCell).urn)
        else if (c.kind === 'path') (c as PathCell).nodes.forEach((n) => add(n.urn))
        else if (c.kind === 'list') (c as ListCell).items.forEach((item) => visit(item, depth + 1))
        else if (c.kind === 'map') Object.values((c as MapCell).entries).forEach((v) => visit(v, depth + 1))
    }
    const named = columns.map(urnColumn)
    for (const row of rows) {
        row.forEach((cell, i) => {
            if (named[i] && typeof cell === 'string') add(cell)
            else visit(cell, 0)
        })
    }
    return [...seen]
}


/** A cell in one line of text — for titles, copies and screen readers. */
export function cellText(cell: NativeCell): string {
    if (cell === null) return 'null'
    if (typeof cell !== 'object') return String(cell)
    switch (cell.kind) {
        case 'node': return cell.displayName ?? cell.urn ?? `(${cell.labels.join(':') || 'node'} ${cell.id})`
        case 'edge': return `-[${cell.type}]->`
        case 'path': return `path of ${cell.size ?? cell.edges.length} step${(cell.size ?? cell.edges.length) === 1 ? '' : 's'}`
        case 'map': return `{${Object.keys(cell.entries).join(', ')}}`
        case 'list': return `[${cell.items.map(cellText).join(', ')}]`
        case 'temporal': return cell.text
        case 'point': return `point(${cell.coordinates.join(', ')})`
        case 'bytes': return `${cell.length} bytes`
        case 'number': return cell.text
        case 'string': return `${cell.text}…`
        case 'truncated': return '…'
    }
}


/** What a native query's highlight is marked with in the search store's
 *  ``queryHash`` — so a search's own result handling can leave it alone. */
export const NATIVE_RESULT_PREFIX = 'native:'

export function isNativeResult(queryHash: string | null): boolean {
    return queryHash?.startsWith(NATIVE_RESULT_PREFIX) ?? false
}
