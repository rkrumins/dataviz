/**
 * What the identity provider sends — as keys you can act on.
 *
 * The old editor rendered the sample as a 4-row textarea plus a strip of
 * "detected keys" whose buttons copied to the clipboard, leaving the
 * operator to paste each one into a field themselves. Its own docstring
 * described the interaction that was wanted — "every key becomes a chip you
 * can drop onto a field" — and the code did not do it.
 *
 * So: click a key, pick a field, done. A menu rather than drag, because
 * every route through it has to work from the keyboard, and a drag target
 * has no keyboard equivalent that is not a menu anyway.
 *
 * Each key also carries its state against the current mapping, which is the
 * part an operator cannot work out by reading:
 *
 *   mapped     this key is what fills that field
 *   shadowed   listed as a candidate, but an earlier one already won —
 *              i.e. it is being maintained for nothing
 *   unmapped   nothing reads it
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FIELDS, labelForResolvedKey } from './fields'

export type KeyState =
    | { kind: 'mapped'; field: string }
    | { kind: 'shadowed'; field: string }
    | { kind: 'unmapped' }

/** One row of the payload: the key, its value, and what reads it. */
export interface PayloadKey {
    path: string
    /** Rendered compactly — objects and arrays are summarised, not dumped. */
    preview: string
    state: KeyState
}

export function summarise(value: unknown): string {
    if (value === null) return 'null'
    if (Array.isArray(value)) {
        return value.length ? `[${value.map(summarise).join(', ')}]` : '[]'
    }
    if (typeof value === 'object') {
        const n = Object.keys(value as object).length
        return `{${n} field${n === 1 ? '' : 's'}}`
    }
    return String(value)
}

export function PayloadPane({
    keys, onAssign, onAddExtra, empty,
}: {
    keys: PayloadKey[]
    onAssign: (path: string, field: string) => void
    onAddExtra: (path: string) => void
    /** Shown instead of the list when there is no usable sample. */
    empty?: React.ReactNode
}) {
    return (
        <div className="min-w-0">
            <h4 className="text-xs font-semibold text-ink uppercase tracking-wider">
                They send
            </h4>
            <p className="mt-1 text-[11px] text-ink-muted">
                Click a key to assign it to one of our fields.
            </p>

            {keys.length === 0 ? (
                <div className="mt-3 rounded-xl border border-dashed border-black/[0.10] dark:border-white/[0.12] p-4 text-[11px] text-ink-muted">
                    {empty ?? 'No sample yet.'}
                </div>
            ) : (
                <ul className="mt-3 space-y-1">
                    {keys.map(k => (
                        <li key={k.path}>
                            <KeyRow
                                item={k}
                                onAssign={f => onAssign(k.path, f)}
                                onAddExtra={() => onAddExtra(k.path)}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function KeyRow({
    item, onAssign, onAddExtra,
}: {
    item: PayloadKey
    onAssign: (field: string) => void
    onAddExtra: () => void
}) {
    const [open, setOpen] = useState(false)
    const wrap = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        function away(e: MouseEvent) {
            if (!wrap.current?.contains(e.target as Node)) setOpen(false)
        }
        function esc(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', away)
        document.addEventListener('keydown', esc)
        return () => {
            document.removeEventListener('mousedown', away)
            document.removeEventListener('keydown', esc)
        }
    }, [open])

    const state = item.state
    const mapped = state.kind === 'mapped'
    const shadowed = state.kind === 'shadowed'

    return (
        <div ref={wrap} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition-colors duration-150',
                    mapped
                        ? 'border-emerald-400/50 bg-emerald-500/[0.07]'
                        : 'border-black/[0.08] dark:border-white/[0.10] hover:border-indigo-500/40 hover:bg-indigo-500/[0.04]',
                )}
            >
                <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[11px] text-ink truncate">
                        {item.path}
                    </span>
                    <span className="block font-mono text-[10px] text-ink-muted truncate">
                        {item.preview}
                    </span>
                </span>
                {state.kind === 'mapped' && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                        {labelForResolvedKey(state.field)}
                    </span>
                )}
                {shadowed && (
                    // Not an error — but an operator maintaining a fallback
                    // that can never fire deserves to know it never fires.
                    <span
                        title="Listed for this field, but an earlier key already resolves it"
                        className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400"
                    >
                        shadowed
                    </span>
                )}
                <ChevronDown className="shrink-0 w-3.5 h-3.5 text-ink-muted" />
            </button>

            {open && (
                <div
                    role="menu"
                    className="absolute z-20 mt-1 w-56 right-0 rounded-xl border border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated shadow-lg py-1"
                >
                    {FIELDS.map(f => (
                        <button
                            key={f.key}
                            role="menuitem"
                            type="button"
                            onClick={() => { onAssign(f.key); setOpen(false) }}
                            className="w-full text-left px-3 py-1.5 text-xs text-ink hover:bg-indigo-500/10"
                        >
                            {f.label}
                            {/* Decorative: a screen reader announcing
                                "Email star" is worse than just "Email". */}
                            {f.required && (
                                <span aria-hidden="true" className="text-red-500 ml-0.5">*</span>
                            )}
                        </button>
                    ))}
                    <div className="my-1 border-t border-black/[0.08] dark:border-white/[0.10]" />
                    <button
                        role="menuitem"
                        type="button"
                        onClick={() => { onAddExtra(); setOpen(false) }}
                        className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-indigo-500/10 flex items-center gap-1.5"
                    >
                        <Plus className="w-3 h-3" />
                        Keep as an extra attribute
                    </button>
                </div>
            )}
        </div>
    )
}
