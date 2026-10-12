/**
 * JsonTree — a record as it was written, made readable.
 *
 * For the moment a summary is not enough and someone needs the record itself:
 * keys, strings, numbers and literals each in their own colour; branches past
 * the first levels folded, each saying how much it holds; every branch one
 * click from open or shut, the whole tree one click from all open; and the
 * document, exactly as JSON, one click from the clipboard.
 *
 * A record can be large. A long list shows its first entries and offers the
 * rest a page at a time; a long string is cut short until asked. Nothing is
 * parsed or evaluated: it draws the value it is given.
 */
import { useMemo, useState } from 'react'
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'

import { cn } from '@/lib/utils'

import { CopyButton } from './CopyButton'

/** Entries drawn per branch before "show more". */
export const JSON_PAGE = 50
/** Characters of a string drawn before it is cut short. */
export const JSON_STRING_CUT = 240

const TOKEN = {
    key: 'text-sky-700 dark:text-sky-300',
    index: 'text-ink-muted',
    string: 'text-emerald-700 dark:text-emerald-300',
    number: 'text-amber-700 dark:text-amber-300',
    literal: 'text-violet-700 dark:text-violet-300',
    punct: 'text-ink-muted',
}

const LINK = 'rounded px-1 font-sans text-[10px] font-semibold text-accent-lineage hover:bg-accent-lineage/10 outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

function JsonString({ text }: { text: string }) {
    const [whole, setWhole] = useState(false)
    const cut = text.length > JSON_STRING_CUT && !whole
    return (
        <span className={cn(TOKEN.string, 'break-all')}>
            &quot;{cut ? text.slice(0, JSON_STRING_CUT) : text}{cut && '…'}&quot;
            {text.length > JSON_STRING_CUT && (
                <button type="button" onClick={() => setWhole((v) => !v)} className={cn(LINK, 'ml-1')}>
                    {whole ? 'less' : `+${(text.length - JSON_STRING_CUT).toLocaleString()} characters`}
                </button>
            )}
        </span>
    )
}

function Leaf({ value }: { value: unknown }) {
    if (typeof value === 'string') return <JsonString text={value} />
    if (typeof value === 'number') return <span className={TOKEN.number}>{String(value)}</span>
    // null, booleans — and undefined, which JSON would have dropped.
    return <span className={TOKEN.literal}>{value === undefined ? 'null' : String(value)}</span>
}

function Key({ name }: { name: string | number | undefined }) {
    if (name === undefined) return null
    return typeof name === 'number' ? (
        <><span className={TOKEN.index}>{name}</span><span className={TOKEN.punct}>: </span></>
    ) : (
        <><span className={TOKEN.key}>&quot;{name}&quot;</span><span className={TOKEN.punct}>: </span></>
    )
}

function Branch({ name, value, depth, openDepth, last }: {
    name?: string | number
    value: unknown
    depth: number
    openDepth: number
    last: boolean
}) {
    const [open, setOpen] = useState(depth < openDepth)
    const [shown, setShown] = useState(JSON_PAGE)
    const comma = last ? null : <span className={TOKEN.punct}>,</span>

    if (value === null || typeof value !== 'object') {
        return (
            <div className="pl-4">
                <Key name={name} /><Leaf value={value} />{comma}
            </div>
        )
    }

    const list = Array.isArray(value)
    const entries: [string | number, unknown][] = list
        ? (value as unknown[]).map((v, i) => [i, v])
        : Object.entries(value as Record<string, unknown>)
    const [start, end] = list ? ['[', ']'] : ['{', '}']

    if (entries.length === 0) {
        return (
            <div className="pl-4">
                <Key name={name} /><span className={TOKEN.punct}>{start}{end}</span>{comma}
            </div>
        )
    }

    const count = `${entries.length.toLocaleString()} ${list
        ? (entries.length === 1 ? 'item' : 'items')
        : (entries.length === 1 ? 'key' : 'keys')}`

    return (
        <div>
            <button
                type="button"
                aria-expanded={open}
                // Read as what it is, not as punctuation: "limits — 1 key".
                aria-label={`${name === undefined ? 'Document' : typeof name === 'number' ? `Item ${name}` : name} — ${count}`}
                onClick={() => setOpen((v) => !v)}
                className="group/branch -ml-px flex max-w-full items-center rounded text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.05] outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
            >
                <ChevronRight
                    aria-hidden
                    className={cn('h-3 w-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-90')}
                />
                <span className="min-w-0 truncate">
                    <Key name={name} />
                    <span className={TOKEN.punct}>{start}</span>
                    {!open && (
                        <>
                            <span className="mx-1 rounded bg-black/[0.05] px-1 font-sans text-[10px] font-semibold text-ink-muted dark:bg-white/[0.07]">
                                {count}
                            </span>
                            <span className={TOKEN.punct}>{end}</span>{comma}
                        </>
                    )}
                </span>
            </button>
            {open && (
                <>
                    <div className="ml-[7px] border-l border-black/[0.07] pl-2.5 dark:border-white/[0.08]">
                        {entries.slice(0, shown).map(([key, child], i) => (
                            <Branch
                                key={key}
                                name={key}
                                value={child}
                                depth={depth + 1}
                                openDepth={openDepth}
                                last={i === entries.length - 1}
                            />
                        ))}
                        {entries.length > shown && (
                            <div className="py-0.5 pl-4">
                                <button type="button" onClick={() => setShown((n) => n + JSON_PAGE)} className={LINK}>
                                    Show {Math.min(JSON_PAGE, entries.length - shown).toLocaleString()} more
                                    {' '}of {(entries.length - shown).toLocaleString()}
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="pl-4"><span className={TOKEN.punct}>{end}</span>{comma}</div>
                </>
            )}
        </div>
    )
}

export function JsonTree({ value, label, openDepth = 2, className }: {
    value: unknown
    /** What the document is, for the copy button and assistive tech: "event payload". */
    label: string
    /** Levels open on first draw; deeper branches start folded. */
    openDepth?: number
    className?: string
}) {
    // Expand / collapse all re-draws the tree with a new opening depth; each
    // branch keeps its own state from there.
    const [view, setView] = useState({ depth: openDepth, generation: 0 })
    const text = useMemo(() => JSON.stringify(value, null, 2) ?? 'null', [value])
    const control = 'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-semibold text-ink-muted hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.07] outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'

    return (
        <div className={cn('overflow-hidden rounded-xl border border-black/[0.07] bg-black/[0.015] dark:border-white/[0.08] dark:bg-white/[0.02]', className)}>
            <div className="flex items-center justify-end gap-0.5 border-b border-black/[0.05] px-1.5 py-1 dark:border-white/[0.06]">
                <button
                    type="button"
                    className={control}
                    onClick={() => setView((v) => ({ depth: Number.POSITIVE_INFINITY, generation: v.generation + 1 }))}
                >
                    <ChevronsUpDown aria-hidden className="h-3 w-3" /> Expand all
                </button>
                <button
                    type="button"
                    className={control}
                    onClick={() => setView((v) => ({ depth: 1, generation: v.generation + 1 }))}
                >
                    <ChevronsDownUp aria-hidden className="h-3 w-3" /> Collapse
                </button>
                <CopyButton value={text} label={`Copy ${label} as JSON`} />
            </div>
            <div
                role="group"
                aria-label={label}
                tabIndex={0}
                className="max-h-[28rem] overflow-auto px-2 py-2 font-mono text-[11px] leading-5 custom-scrollbar outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/40"
            >
                <Branch key={view.generation} value={value} depth={0} openDepth={view.depth} last />
            </div>
        </div>
    )
}
