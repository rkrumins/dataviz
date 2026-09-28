/**
 * libraryFile — a view library pack as a file: saved from an export, read
 * back for an import.
 *
 * Read losslessly, so a 64-bit integer in a rule's criteria (a hash, an id)
 * reaches the server as the exact digits the file holds.
 */
import { parseJsonLossless } from '@/lib/losslessJson'
import { LIBRARY_PACK_FORMAT, type LibraryPack } from '@/services/viewLibraryService'


/** Hand the browser the pack to save as ``<view name>.library.json``. */
export function saveLibraryFile(pack: LibraryPack): void {
    const stem = (pack.source?.viewName ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${stem.slice(0, 80) || 'view'}.library.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
}


/** The pack in ``file``, or an error that says why it isn't one. */
export async function readLibraryFile(file: File): Promise<LibraryPack> {
    const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(new Error("The file couldn't be read."))
        reader.readAsText(file)
    })
    let parsed: unknown
    try {
        parsed = parseJsonLossless(text)
    } catch {
        throw new Error("This file isn't JSON.")
    }
    const pack = parsed as Partial<LibraryPack> | null
    if (!pack || typeof pack !== 'object' || pack.format !== LIBRARY_PACK_FORMAT) {
        throw new Error("This isn't a view library file — export one from a view's Property Manager.")
    }
    if (pack.version !== 1) {
        throw new Error(`This library file is version ${String(pack.version)}; this app reads version 1.`)
    }
    return pack as LibraryPack
}
