/**
 * LeafPickerDropdown — portalled, categorised, search-as-you-type
 * leaf-kind picker. Used inside group cards by AddRowButton (and could
 * be wired into AddFilterPalette at the root in a future pass).
 *
 * Portal-to-body lets the popover escape the parent group card's
 * stacking context — the previous inline ``absolute`` dropdown got
 * clipped behind sibling group cards rendered after it in DOM order.
 *
 * Visual identity matches AddFilterPalette's popover (fully opaque
 * canvas-elevated, heavy shadow, search input on top) so users
 * experience one picker style throughout the panel.
 */
import { motion } from 'framer-motion'
import { Search } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import { type FC, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

import { LEAF_KINDS, type LeafKindMeta } from '../../builder/leafKinds'


const CATEGORY_LABELS: Record<LeafKindMeta['category'], string> = {
    property: 'Tags & properties',
    identity: 'Structure',
    graph: 'Lineage',
    scope: 'Scope',
    text: 'Text',
}


const CATEGORY_ORDER: ReadonlyArray<LeafKindMeta['category']> = [
    'text', 'identity', 'property', 'graph', 'scope',
]


function iconFor(name: string): FC<{ className?: string; strokeWidth?: number }> {
    const Component = (LucideIcons as unknown as Record<
        string, FC<{ className?: string; strokeWidth?: number }>
    >)[name]
    return Component ?? LucideIcons.Sparkles
}


export interface LeafPickerDropdownProps {
    open: boolean
    /** The trigger button — used to measure anchor coords. */
    anchorRef: React.RefObject<HTMLElement | null>
    onPick: (meta: LeafKindMeta) => void
    onDismiss: () => void
    /** Filter the leaf list (used to hide e.g. ``scope`` kinds inside
     *  deep nesting). Defaults to "everything". */
    filter?: (meta: LeafKindMeta) => boolean
}


export const LeafPickerDropdown: FC<LeafPickerDropdownProps> = ({
    open, anchorRef, onPick, onDismiss, filter,
}) => {
    const popoverRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const [coords, setCoords] = useState<{
        top: number; left: number; width: number;
    } | null>(null)
    const [query, setQuery] = useState('')
    const [highlight, setHighlight] = useState(0)

    // Measure anchor on open + scroll + resize so the portalled popover
    // tracks the trigger button. Same pattern AddFilterPalette uses.
    useLayoutEffect(() => {
        if (!open) { setCoords(null); return }
        const update = () => {
            const r = anchorRef.current?.getBoundingClientRect()
            if (!r) return
            const sentinel = anchorRef.current?.closest<HTMLElement>(
                '[data-search-panel-content]',
            )
            const containerRect = sentinel?.getBoundingClientRect()
            const popoverW = Math.max(
                320, Math.min(480, containerRect?.width ?? 360),
            )
            const viewportW = window.innerWidth
            const viewportH = window.innerHeight
            // Default: anchor under the trigger. If that overflows the
            // viewport bottom, pop upward.
            let top = r.bottom + 4
            const estHeight = 360
            if (top + estHeight > viewportH - 8) {
                top = Math.max(8, r.top - estHeight - 4)
            }
            // Clamp left so we stay inside the viewport.
            const containerLeft = containerRect?.left ?? r.left
            const left = Math.min(
                Math.max(8, containerLeft),
                viewportW - popoverW - 8,
            )
            setCoords({ top, left, width: popoverW })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [open, anchorRef])

    // Focus the search input on open.
    useEffect(() => {
        if (open) inputRef.current?.focus()
    }, [open])

    // Outside-click + Escape dismiss.
    useEffect(() => {
        if (!open) return
        const onClick = (e: MouseEvent) => {
            if (popoverRef.current?.contains(e.target as Node)) return
            if (anchorRef.current?.contains(e.target as Node)) return
            onDismiss()
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onDismiss()
        }
        document.addEventListener('mousedown', onClick)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onClick)
            document.removeEventListener('keydown', onKey)
        }
    }, [open, anchorRef, onDismiss])

    const filtered = useMemo<LeafKindMeta[]>(() => {
        const q = query.trim().toLowerCase()
        const base = filter ? LEAF_KINDS.filter(filter) : [...LEAF_KINDS]
        if (!q) return base
        return base.filter((m) =>
            m.label.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q) ||
            m.kind.toLowerCase().includes(q),
        )
    }, [filter, query])

    useEffect(() => {
        if (highlight >= filtered.length) {
            setHighlight(Math.max(0, filtered.length - 1))
        }
    }, [filtered.length, highlight])

    const grouped = useMemo(() => {
        const buckets = new Map<LeafKindMeta['category'], LeafKindMeta[]>()
        for (const m of filtered) {
            if (!buckets.has(m.category)) buckets.set(m.category, [])
            buckets.get(m.category)!.push(m)
        }
        return CATEGORY_ORDER
            .filter((cat) => buckets.has(cat))
            .map((cat) => ({ cat, entries: buckets.get(cat)! }))
    }, [filtered])

    function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlight((i) => Math.min(filtered.length - 1, i + 1))
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlight((i) => Math.max(0, i - 1))
        } else if (e.key === 'Enter') {
            e.preventDefault()
            const pick = filtered[highlight]
            if (pick) onPick(pick)
        } else if (e.key === 'Escape') {
            e.preventDefault()
            onDismiss()
        }
    }

    if (!open || !coords) return null

    // Build a flat index map so highlight state spans across category
    // sections.
    let flatIdx = 0

    const popover = (
        <>
            {/* No AnimatePresence: the popover unmounts instantly on close so an
                interrupted exit can never strand an invisible click-blocker at
                z-1000 over the toolbar. It still animates in. */}
            <motion.div
                ref={popoverRef}
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: 0.12 }}
                style={{
                    position: 'fixed',
                    top: coords.top,
                    left: coords.left,
                    width: coords.width,
                    zIndex: 9999,
                }}
                className={cn(
                    'rounded-xl border border-glass-border',
                    'bg-canvas-elevated',
                    'shadow-2xl shadow-black/50',
                    'flex flex-col overflow-hidden',
                )}
            >
                <div className={cn(
                    'flex items-center gap-2 px-3 py-2.5 border-b border-glass-border/60',
                    'bg-canvas-base/40',
                )}>
                    <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={2} />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value)
                            setHighlight(0)
                        }}
                        onKeyDown={handleKey}
                        placeholder="Filter conditions…"
                        className={cn(
                            'flex-1 min-w-0 bg-transparent outline-none border-none p-0',
                            'text-[12.5px] text-ink placeholder:text-ink-muted/55',
                        )}
                    />
                </div>
                <div className="max-h-[22rem] overflow-y-auto custom-scrollbar py-1">
                    {filtered.length === 0 ? (
                        <div className="px-4 py-6 text-center text-[11px] text-ink-muted leading-snug">
                            No condition matches <span className="font-mono text-ink">{query}</span>.
                        </div>
                    ) : (
                        grouped.map(({ cat, entries }) => (
                            <div key={cat}>
                                <div className={cn(
                                    'px-3 pt-2 pb-1 text-[9px] font-semibold uppercase',
                                    'tracking-[0.14em] text-ink-muted/70',
                                )}>
                                    {CATEGORY_LABELS[cat]}
                                </div>
                                {entries.map((m) => {
                                    const idx = flatIdx++
                                    const Icon = iconFor(m.icon)
                                    return (
                                        <button
                                            key={m.kind}
                                            type="button"
                                            onClick={() => onPick(m)}
                                            onMouseEnter={() => setHighlight(idx)}
                                            className={cn(
                                                'w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors',
                                                idx === highlight
                                                    ? 'bg-accent-lineage/12'
                                                    : 'hover:bg-glass/30',
                                            )}
                                        >
                                            <span className={cn(
                                                'shrink-0 mt-0.5 rounded-lg p-1.5',
                                                'bg-accent-lineage/10 text-accent-lineage',
                                            )}>
                                                <Icon className="w-3.5 h-3.5" strokeWidth={2} />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="text-[12.5px] font-medium text-ink leading-tight block">
                                                    {m.label}
                                                </span>
                                                <span className="block mt-0.5 text-[10.5px] text-ink-muted leading-snug">
                                                    {m.description}
                                                </span>
                                            </span>
                                        </button>
                                    )
                                })}
                            </div>
                        ))
                    )}
                </div>
            </motion.div>
        </>
    )

    return createPortal(popover, document.body)
}
