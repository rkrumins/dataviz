import type { Block } from '../api/types'

/** The citation numbers an answer's sources carry. */
export function citationNumbers(blocks: Block[]): Set<number> {
    const out = new Set<number>()
    for (const b of blocks) if (b.type === 'citations') for (const c of b.data.items) out.add(c.n)
    return out
}

export const CITE_HREF = '#cite-'

/**
 * `[1]` in the answer's text, as a link to its source — only for numbers a source carries, and
 * never inside code (fenced or inline), where brackets are the code's own.
 */
export function linkCitations(text: string, cited: ReadonlySet<number>): string {
    if (cited.size === 0) return text
    return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, i) => (i % 2 === 1 ? part
        : part.replace(/\[(\d{1,3})\](?![(:[])/g, (m, n: string) => (cited.has(Number(n)) ? `[\\[${n}\\]](${CITE_HREF}${n})` : m))))
        .join('')
}
