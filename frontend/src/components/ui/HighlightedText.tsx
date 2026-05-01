import { useMemo } from 'react'

interface HighlightedTextProps {
    text: string
    query: string
    className?: string
    matchClassName?: string
}

/**
 * Renders `text` with case-insensitive occurrences of `query` wrapped in a
 * styled `<mark>`. Bolds all matches; safe with arbitrary user input
 * (no dangerouslySetInnerHTML).
 */
export function HighlightedText({
    text,
    query,
    className,
    matchClassName = 'bg-accent-business/15 text-accent-business font-bold rounded px-0.5',
}: HighlightedTextProps) {
    const parts = useMemo(() => splitHighlights(text, query), [text, query])
    return (
        <span className={className}>
            {parts.map((p, i) =>
                p.match ? (
                    <mark key={i} className={matchClassName}>{p.text}</mark>
                ) : (
                    <span key={i}>{p.text}</span>
                )
            )}
        </span>
    )
}

interface Part {
    text: string
    match: boolean
}

function splitHighlights(text: string, rawQuery: string): Part[] {
    const q = rawQuery.trim()
    if (!q || !text) return [{ text, match: false }]
    const lcText = text.toLowerCase()
    const lcQuery = q.toLowerCase()
    const parts: Part[] = []
    let cursor = 0
    while (cursor < text.length) {
        const idx = lcText.indexOf(lcQuery, cursor)
        if (idx === -1) {
            parts.push({ text: text.slice(cursor), match: false })
            break
        }
        if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false })
        parts.push({ text: text.slice(idx, idx + lcQuery.length), match: true })
        cursor = idx + lcQuery.length
    }
    return parts
}
