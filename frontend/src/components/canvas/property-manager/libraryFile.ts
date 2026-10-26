/**
 * libraryFile — a view library pack as a file: saved from an export, read
 * back for an import — and one query on its own, in a pack of one, so it
 * opens in any view (or imports, name and description kept, like any
 * other pack).
 *
 * Read losslessly, so a 64-bit integer in a rule's criteria (a hash, an id)
 * reaches the server as the exact digits the file holds.
 */
import { parseJsonLossless } from '@/lib/losslessJson'
import { LIBRARY_PACK_FORMAT, type LibraryPack } from '@/services/viewLibraryService'
import type { Predicate } from '@/types/search'


/** ``name`` as a file name's stem. */
const stemOf = (name: string | null | undefined) =>
    (name ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)

function download(contents: unknown, fileName: string): void {
    const blob = new Blob([JSON.stringify(contents, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}


/** Hand the browser the pack to save as ``<view name>.library.json``. */
export function saveLibraryFile(pack: LibraryPack): void {
    download(pack, `${stemOf(pack.source?.viewName) || 'view'}.library.json`)
}


/** A query to keep, or open in another view. */
export interface QueryToKeep {
    name: string
    description?: string | null
    predicate: Predicate
}

/** One query as a pack of one, from the view it was saved on. */
export function queryPack(query: QueryToKeep, source: { viewId: string; viewName?: string | null }): LibraryPack {
    return {
        format: LIBRARY_PACK_FORMAT,
        version: 1,
        exportedAt: new Date().toISOString(),
        source: { viewId: source.viewId, viewName: source.viewName ?? null },
        displayRules: [],
        savedQueries: [{
            name: query.name,
            ...(query.description ? { description: query.description } : {}),
            predicate: query.predicate,
        }],
    }
}

/** Hand the browser one query to save as ``<query name>.library.json``. */
export function saveQueryFile(query: QueryToKeep, source: { viewId: string; viewName?: string | null }): void {
    download(queryPack(query, source), `${stemOf(query.name) || 'query'}.library.json`)
}


async function readJson(file: File): Promise<unknown> {
    const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error("The file couldn't be read."))
        reader.readAsText(file)
    })
    try {
        return parseJsonLossless(text)
    } catch {
        throw new Error("This file isn't JSON.")
    }
}

/** ``parsed`` as a pack, when it says it is one; an error when it's a
 *  version this app doesn't read; ``null`` when it isn't one at all. */
function asPack(parsed: unknown): LibraryPack | null {
    const pack = parsed as Partial<LibraryPack> | null
    if (!pack || typeof pack !== 'object' || pack.format !== LIBRARY_PACK_FORMAT) return null
    if (pack.version !== 1) {
        throw new Error(`This library file is version ${String(pack.version)}; this app reads version 1.`)
    }
    return pack as LibraryPack
}


/** The pack in ``file``, or an error that says why it isn't one. */
export async function readLibraryFile(file: File): Promise<LibraryPack> {
    const pack = asPack(await readJson(file))
    if (!pack) throw new Error("This isn't a view library file — export one from a view's Property Manager.")
    return pack
}


/** What a file opened as a query holds: one query (a pack of one, a
 *  search's own JSON — ``*.search.json`` — or a bare condition), or a pack
 *  of several, to import. */
export type QueryFile =
    | { kind: 'query'; query: QueryToKeep }
    | { kind: 'pack'; pack: LibraryPack }

/** ``file`` read as a query, or an error that says why it holds none. */
export async function readQueryFile(file: File): Promise<QueryFile> {
    const parsed = await readJson(file)
    const stem = file.name.replace(/(\.(library|search))?\.json$/i, '') || 'Opened query'
    const pack = asPack(parsed)
    if (pack) {
        const queries = (pack.savedQueries ?? []) as Partial<QueryToKeep>[]
        const [only] = queries
        if (queries.length === 1 && !pack.displayRules?.length && only?.predicate) {
            return { kind: 'query', query: {
                name: only.name || stem, description: only.description ?? null, predicate: only.predicate } }
        }
        return { kind: 'pack', pack }
    }
    const body = parsed as { predicate?: unknown; kind?: unknown } | null
    if (body && typeof body === 'object' && body.predicate && typeof body.predicate === 'object') {
        return { kind: 'query', query: { name: stem, predicate: body.predicate as Predicate } }
    }
    if (body && typeof body === 'object' && typeof body.kind === 'string') {
        return { kind: 'query', query: { name: stem, predicate: body as Predicate } }
    }
    throw new Error("This file holds no query — download one from a library's Download button.")
}
