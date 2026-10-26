/**
 * CompactLine — a finished condition as one line of words, the way the
 * Sentence reads it: "Type is Dataset", "Is tagged #Certified",
 * "rowCount is more than 100000". Each part a person picked is a token
 * that opens the condition's own editor — the card's — so changing it
 * needs no card opened.
 */
import { type ReactNode, useMemo, useState } from 'react'

import { useEntityVisual } from '@/hooks/useEntityVisual'
import type { Predicate } from '@/types/search'

import type { LayerOption } from './layerOptions'
import { TypeIcon } from './sentence/editors'
import { toRuns } from './sentence/lineWords'
import { Token, type TokenTone } from './sentence/Token'
import { useTypeName } from './sentence/useTypeName'
import { leafSegments } from './vocabulary/sentenceGrammar'


const SHAPES = new Set(['isRoot', 'isLeaf', 'isOrphan', 'hasIncoming', 'hasOutgoing'])


export function CompactLine({ value, title, editor, layers }: {
    value: Predicate
    /** The kind's name: the heading of each token's popover. */
    title: string
    /** The condition's editor, as its card shows it. */
    editor: ReactNode
    /** The view's layers, to name a layer filter's layer. */
    layers: LayerOption[]
}) {
    const [open, setOpen] = useState<number | null>(null)
    const typeName = useTypeName()
    const firstType = value.kind === 'entityType' ? value.values[0] ?? '' : ''
    const typeColor = useEntityVisual(firstType).color
    const runs = useMemo(() => toRuns(leafSegments(value)), [value])

    const token = (i: number, tone: TokenTone, text: string, look?: { icon?: ReactNode; color?: string }) => (
        <Token key={i} open={open === i} onOpenChange={(o) => setOpen(o ? i : null)}
               tone={tone} title={title} width="lg" editor={editor} {...look}
               // The Form's size, a step under the Sentence's.
               className="px-1 text-[13px] leading-5"
               // A shape's words are its name: said once.
               ariaLabel={text.toLowerCase() === title.toLowerCase() ? text : `${title}: ${text}`}>
            {text}
        </Token>
    )
    const words = (i: number, text: string) => <span key={i} className="text-ink-muted">{text}</span>

    let parts: ReactNode[]
    if (value.kind === 'entityType') {
        // Types by their names, in their own colour — not their ids.
        const verb = value.op === 'notIn' ? 'is not' : 'is'
        parts = [
            token(0, 'phrase', `Type ${verb}${value.values.length > 1 ? ' one of' : ''}`),
            token(1, 'entity', value.values.map((t) => typeName(t)).join(', '),
                { icon: <TypeIcon type={firstType} />, color: typeColor }),
        ]
    } else if (SHAPES.has(value.kind ?? '')) {
        // A shape reads as its name, the card's own: a sentence's "nothing
        // links into" needs the entity before it.
        parts = [token(0, 'phrase', title)]
    } else if (value.kind === 'layer') {
        const layer = layers.find((l) => l.value === value.layerAssignment)
        parts = [words(0, 'In layer'), token(1, 'value', layer?.label ?? value.layerAssignment)]
    } else {
        parts = runs.flatMap((run, i) => {
            const text = run.text.trim()
            // The line opens with its words capitalised; a key or a name keeps its case.
            const shown = i === 0 && run.tone !== 'value' ? text.charAt(0).toUpperCase() + text.slice(1) : text
            if (run.slot) return [token(i, run.tone === 'gap' ? 'gap' : run.tone === 'value' ? 'value' : 'phrase', shown)]
            if (run.tone === 'em') return [<strong key={i} className="font-semibold text-rose-500 dark:text-rose-300">{shown}</strong>]
            return shown ? [words(i, shown)] : []
        })
    }
    // Spaced as well as gapped: a screen reader, or a copy, reads the words apart.
    return (
        <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5 min-w-0 text-[13px]">
            {parts.flatMap((part, i) => (i ? [' ', part] : [part]))}
        </span>
    )
}
