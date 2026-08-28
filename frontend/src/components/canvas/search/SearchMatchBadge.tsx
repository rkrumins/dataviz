/**
 * SearchMatchBadge — compact "N matches inside" indicator + premium
 * hover tooltip for collapsed ancestor rows on the lineage canvas.
 *
 *   [✦ 36]   ← single-line pill: small sparkle + count
 *
 *   On hover (portal-mounted, anchored with a caret pointing at the
 *   badge):
 *
 *   ┌───────────────────────────────────────────╮
 *   │ ✦                                          │
 *   │ 36  matches inside this subtree            │
 *   │ ────────────────────────────────────────── │
 *   │ ◆ Attributes                           35  │
 *   │   ████████████████████████ 97%             │
 *   │                                            │
 *   │ ◆ Groups                                 1 │
 *   │   ▓                          3%            │
 *   │ ────────────────────────────────────────── │
 *   │ Expand the row to see matching items       │
 *   ╰────────────────────────────────────────────╯
 *                                ▼ (caret)
 *                              [✦ 36]
 *
 * Per-row visuals are sourced from each entity type's
 * ``schema.entityTypes[i].visual`` — icon + color match what the
 * canvas already uses, so the tooltip reads as a familiar slice of
 * the schema rather than an isolated info card.
 *
 * Tooltip is portal-mounted with ``pointer-events-none`` so it never
 * blocks clicks on the row underneath and never gets clipped by
 * parent overflow / scroll containers.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Maximize2, Sparkles } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import type { useSchemaStore } from '@/store/schema'
import { useResultsArePartial } from '@/store/searchStore'


type Schema = ReturnType<typeof useSchemaStore.getState>['schema']


export interface SearchMatchBadgeProps {
    count: number
    breakdown: ReadonlyMap<string, number>
    schema: Schema
}


export function SearchMatchBadge({
    count, breakdown, schema,
}: SearchMatchBadgeProps) {
    // While pages remain unfetched, every roll-up is a LOWER BOUND —
    // it counts the ancestor paths of the hits that have loaded, not
    // the ones still on the server. Read here rather than threaded
    // through four call sites: the badge only mounts where a count
    // exists, so this is a handful of subscriptions to a boolean, not
    // one per canvas row. Renders `✦ 12+` instead of a confident `✦ 12`.
    const approximate = useResultsArePartial()
    const [hovered, setHovered] = useState(false)
    const ref = useRef<HTMLSpanElement>(null)
    const [coords, setCoords] = useState<{
        top: number; left: number
        placeAbove: boolean
        anchorX: number  // where on the X axis the badge sits (for caret)
    } | null>(null)

    useLayoutEffect(() => {
        if (!hovered) { setCoords(null); return }
        const update = () => {
            const r = ref.current?.getBoundingClientRect()
            if (!r) return
            const viewportH = window.innerHeight
            const viewportW = window.innerWidth
            const tooltipW = 280
            const tooltipH = estimateHeight(breakdown.size)
            const spaceBelow = viewportH - r.bottom
            const placeAbove = spaceBelow < tooltipH + 16 && r.top > spaceBelow
            // Anchor near the badge, growing leftward. Clamp inside the
            // viewport with an 8px gutter on each side.
            const idealLeft = r.right - tooltipW
            const left = Math.max(8, Math.min(idealLeft, viewportW - tooltipW - 8))
            const top = placeAbove ? r.top - 10 : r.bottom + 10
            const anchorX = (r.left + r.right) / 2 - left
            setCoords({ top, left, placeAbove, anchorX })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [hovered, breakdown.size])

    const items = useBreakdownItems(breakdown, count, schema)

    return (
        <>
            <motion.span
                ref={ref}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85 }}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                whileHover={{ scale: 1.06 }}
                className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md flex-shrink-0',
                    'bg-amber-500/15 border border-amber-500/40',
                    'text-amber-700 dark:text-amber-300',
                    'text-[10px] font-semibold tabular-nums leading-none',
                    'shadow-[0_0_8px_rgba(245,158,11,0.2)]',
                    'cursor-help transition-shadow',
                    hovered && 'shadow-[0_0_12px_rgba(245,158,11,0.45)]',
                )}
                aria-label={approximate
                    ? `At least ${count} matches in this subtree — more still loading, hover for breakdown`
                    : `${count} matches in this subtree — hover for breakdown`}
            >
                <Sparkles className="w-2.5 h-2.5" strokeWidth={2.5} />
                <span>{count}{approximate && '+'}</span>
            </motion.span>

            {typeof document !== 'undefined' && createPortal(
                <AnimatePresence>
                    {hovered && coords && (
                        <PremiumTooltip
                            count={count}
                            items={items}
                            coords={coords}
                            approximate={approximate}
                        />
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </>
    )
}


// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

const TOOLTIP_W = 280


interface BreakdownItem {
    typeId: string
    label: string  // pluralised display name
    count: number
    pct: number    // 0..1
    color: string  // hex
    icon: string   // Lucide icon name
}


function PremiumTooltip({
    count, items, coords, approximate,
}: {
    count: number
    items: BreakdownItem[]
    coords: {
        top: number; left: number
        placeAbove: boolean
        anchorX: number
    }
    approximate: boolean
}) {
    const caretLeft = Math.max(16, Math.min(TOOLTIP_W - 16, coords.anchorX))
    return (
        <motion.div
            initial={{ opacity: 0, y: coords.placeAbove ? 6 : -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: coords.placeAbove ? 6 : -6, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            style={{
                position: 'fixed',
                top: coords.placeAbove ? undefined : coords.top,
                bottom: coords.placeAbove
                    ? window.innerHeight - coords.top
                    : undefined,
                left: coords.left,
                width: TOOLTIP_W,
                zIndex: 9999,
                pointerEvents: 'none',
            }}
            className={cn(
                'relative rounded-2xl',
                'border border-amber-400/30',
                'bg-gradient-to-br from-canvas-elevated via-canvas-elevated to-canvas-base/95',
                'shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55),0_0_0_1px_rgba(245,158,11,0.08),inset_0_1px_0_rgba(255,255,255,0.04)]',
                'backdrop-blur-xl',
                'overflow-hidden',
            )}
        >
            {/* Amber light sweep at the top — premium "glow from the badge" feel */}
            <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-px"
                style={{
                    background: 'linear-gradient(90deg, transparent, rgba(245,158,11,0.6), transparent)',
                }}
            />
            <div
                aria-hidden
                className="absolute inset-x-0 top-0 h-16 opacity-[0.18] pointer-events-none"
                style={{
                    background: 'radial-gradient(ellipse at 50% 0%, rgba(245,158,11,0.5), transparent 70%)',
                }}
            />

            {/* Hero: count + label */}
            <div className="relative px-4 pt-3.5 pb-3 flex items-start gap-3">
                <div className={cn(
                    'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                    'bg-gradient-to-br from-amber-400/30 to-amber-500/10',
                    'shadow-[inset_0_0_0_1px_rgba(245,158,11,0.35)]',
                )}>
                    <Sparkles className="w-4 h-4 text-amber-300" strokeWidth={2.4} />
                </div>
                <div className="flex flex-col leading-tight">
                    <span className="text-[22px] font-display font-semibold text-ink tabular-nums leading-none">
                        {count.toLocaleString()}{approximate && '+'}
                    </span>
                    <span className="mt-1 text-[11px] text-ink-muted leading-snug">
                        {approximate
                            ? 'matches so far — still loading more'
                            : `${count === 1 ? 'match' : 'matches'} inside this subtree`}
                    </span>
                </div>
            </div>

            {/* Breakdown */}
            {items.length > 0 && (
                <>
                    <Divider />
                    <div className="px-4 pt-2.5 pb-3 flex flex-col gap-2.5">
                        <div className="text-[9.5px] font-mono uppercase tracking-[0.16em] text-ink-muted/70">
                            Breakdown by type
                        </div>
                        <div className="flex flex-col gap-2">
                            {items.map((it) => (
                                <BreakdownRow key={it.typeId} item={it} />
                            ))}
                        </div>
                    </div>
                </>
            )}

            {/* Footer hint */}
            <Divider />
            <div className="px-4 py-2.5 flex items-center gap-1.5 text-[10.5px] text-ink-muted/85">
                <Maximize2 className="w-3 h-3 text-amber-400/80" strokeWidth={2.4} />
                <span>Expand the row to drill into matches.</span>
            </div>

            {/* Caret pointing at the badge */}
            <Caret placeAbove={coords.placeAbove} left={caretLeft} />
        </motion.div>
    )
}


function BreakdownRow({ item }: { item: BreakdownItem }) {
    const pctLabel = item.pct >= 0.995
        ? '100%'
        : item.pct < 0.01
            ? '<1%'
            : `${Math.round(item.pct * 100)}%`
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 min-w-0">
                <div
                    className={cn(
                        'w-6 h-6 rounded-md shrink-0 flex items-center justify-center',
                        'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]',
                    )}
                    style={{
                        background: `linear-gradient(135deg, ${item.color}30 0%, ${item.color}12 100%)`,
                    }}
                >
                    <DynamicIcon
                        name={item.icon}
                        className="w-3 h-3"
                        style={{ color: item.color }}
                    />
                </div>
                <div className="flex-1 min-w-0 text-[11.5px] text-ink truncate font-medium">
                    {item.label}
                </div>
                <div className="text-[11.5px] text-ink tabular-nums font-semibold shrink-0">
                    {item.count.toLocaleString()}
                </div>
            </div>
            <div className="flex items-center gap-1.5 pl-8">
                <div className="flex-1 h-1 rounded-full overflow-hidden bg-white/[0.06]">
                    <motion.div
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: item.pct }}
                        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                        style={{
                            transformOrigin: 'left',
                            background: `linear-gradient(90deg, ${item.color}, ${item.color}cc)`,
                            boxShadow: `0 0 8px ${item.color}55`,
                            height: '100%',
                            width: '100%',
                        }}
                    />
                </div>
                <span className="text-[9.5px] text-ink-muted tabular-nums w-7 text-right">
                    {pctLabel}
                </span>
            </div>
        </div>
    )
}


function Divider() {
    return (
        <div
            aria-hidden
            className="h-px"
            style={{
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent)',
            }}
        />
    )
}


function Caret({ placeAbove, left }: { placeAbove: boolean; left: number }) {
    // CSS-triangle caret. Placed BELOW the tooltip when the tooltip
    // sits above the badge, and ABOVE the tooltip when it sits below.
    const common = {
        position: 'absolute' as const,
        left,
        transform: 'translateX(-50%)',
        width: 0,
        height: 0,
    }
    if (placeAbove) {
        return (
            <span
                aria-hidden
                style={{
                    ...common,
                    bottom: -7,
                    borderLeft: '7px solid transparent',
                    borderRight: '7px solid transparent',
                    borderTop: '7px solid rgba(245,158,11,0.3)',
                    filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.4))',
                }}
            />
        )
    }
    return (
        <span
            aria-hidden
            style={{
                ...common,
                top: -7,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent',
                borderBottom: '7px solid rgba(245,158,11,0.3)',
                filter: 'drop-shadow(0 -1px 0 rgba(0,0,0,0.4))',
            }}
        />
    )
}


// ---------------------------------------------------------------------------
// Data prep
// ---------------------------------------------------------------------------

function useBreakdownItems(
    breakdown: ReadonlyMap<string, number>,
    total: number,
    schema: Schema,
): BreakdownItem[] {
    return useMemo<BreakdownItem[]>(() => {
        const entries = Array.from(breakdown.entries())
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1])
        const sum = entries.reduce((a, [, n]) => a + n, 0) || total || 1
        return entries.map(([typeId, count]) => {
            const et = schema?.entityTypes.find((e) => e.id === typeId)
            const label = (count === 1 ? et?.name : et?.pluralName)
                ?? (count === 1 ? typeId : pluralize(typeId))
            const color = et?.visual?.color ?? '#f59e0b'
            const icon = et?.visual?.icon ?? 'Box'
            return { typeId, label, count, pct: count / sum, color, icon }
        })
    }, [breakdown, total, schema])
}


function estimateHeight(rowCount: number): number {
    // Hero (~70) + breakdown header (~28) + each row (~38) + footer (~36)
    return 70 + (rowCount > 0 ? 28 + rowCount * 38 : 0) + 36
}


function pluralize(word: string): string {
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('ch')) return `${word}es`
    if (word.endsWith('y') && !/[aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
    return `${word}s`
}
