/**
 * DisplayRuleTagChips — the single, shared renderer for Property Manager
 * display-rule tag chips across every canvas (Context View FlatTreeItem,
 * GraphCanvas GenericNode, HierarchyCanvas rows).
 *
 * One source of truth so the premium treatment — framer-motion enter,
 * colored glow, icon support, and the portal "+N" overflow popover —
 * stays identical everywhere. The overflow popover mirrors the
 * gold-standard pattern in ``SearchMatchBadge.tsx`` (portal-mounted,
 * caret, gradient hero, viewport-clamped) so it never clips inside
 * scroll containers or React Flow's transformed pane.
 *
 * Subscribes to ``useDisplayRuleTags(urn)`` internally; renders nothing
 * when the node matches no enabled rule (the common case), so it's cheap
 * to drop into a virtualized list of hundreds of rows.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { Tags } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { cn } from '@/lib/utils'
import { useDisplayRuleTags, type DisplayRuleTag } from '@/store/displayRuleMatchStore'


export interface DisplayRuleTagChipsProps {
    /** Node URN (or fallback id) to resolve tags for. */
    urn: string | undefined
    /** Visual density. ``xs`` for dense tree rows, ``sm`` for graph cards. */
    size?: 'xs' | 'sm'
    /** Max chips shown inline before collapsing into a "+N" pill. */
    max?: number
    className?: string
}


export function DisplayRuleTagChips({
    urn, size = 'xs', max = 3, className,
}: DisplayRuleTagChipsProps) {
    const tags = useDisplayRuleTags(urn)
    if (tags.length === 0) return null

    const inline = tags.slice(0, max)
    const overflow = tags.slice(max)

    return (
        <div className={cn('flex flex-wrap items-center gap-1', className)}>
            <AnimatePresence initial={false}>
                {inline.map((tag) => (
                    <Chip key={tag.id} tag={tag} size={size} />
                ))}
            </AnimatePresence>
            {overflow.length > 0 && (
                <OverflowPill count={overflow.length} all={tags} size={size} />
            )}
        </div>
    )
}


function Chip({ tag, size }: { tag: DisplayRuleTag; size: 'xs' | 'sm' }) {
    const px = size === 'xs' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'
    const icon = size === 'xs' ? 'w-2.5 h-2.5' : 'w-3 h-3'
    return (
        <motion.span
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className={cn(
                'inline-flex items-center gap-1 rounded font-medium leading-none max-w-[140px]',
                px,
            )}
            style={{
                backgroundColor: `${tag.color}26`,
                color: tag.color,
                boxShadow: `0 0 0 1px ${tag.color}33, 0 0 8px ${tag.color}1f`,
            }}
            title={tag.name}
        >
            {tag.icon && <DynamicIcon name={tag.icon} className={cn(icon, 'shrink-0')} />}
            <span className="truncate">{tag.name}</span>
        </motion.span>
    )
}


function OverflowPill({
    count, all, size,
}: {
    count: number
    all: ReadonlyArray<DisplayRuleTag>
    size: 'xs' | 'sm'
}) {
    const [hovered, setHovered] = useState(false)
    const ref = useRef<HTMLSpanElement>(null)
    const [coords, setCoords] = useState<{ top: number; left: number; placeAbove: boolean; anchorX: number } | null>(null)
    const px = size === 'xs' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'

    useLayoutEffect(() => {
        if (!hovered) { setCoords(null); return }
        const update = () => {
            const r = ref.current?.getBoundingClientRect()
            if (!r) return
            const W = 240
            const estH = 56 + all.length * 26
            const spaceBelow = window.innerHeight - r.bottom
            const placeAbove = spaceBelow < estH + 16 && r.top > spaceBelow
            const idealLeft = r.right - W
            const left = Math.max(8, Math.min(idealLeft, window.innerWidth - W - 8))
            const top = placeAbove ? r.top - 8 : r.bottom + 8
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
    }, [hovered, all.length])

    return (
        <>
            <span
                ref={ref}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                className={cn(
                    'inline-flex items-center rounded font-semibold tabular-nums leading-none cursor-help',
                    'bg-glass/50 text-ink-muted hover:text-ink transition-colors',
                    px,
                )}
                aria-label={`${count} more display-rule tags`}
            >
                +{count}
            </span>
            {typeof document !== 'undefined' && createPortal(
                <AnimatePresence>
                    {hovered && coords && (
                        <OverflowPopover all={all} coords={coords} />
                    )}
                </AnimatePresence>,
                document.body,
            )}
        </>
    )
}


const POPOVER_W = 240


function OverflowPopover({
    all, coords,
}: {
    all: ReadonlyArray<DisplayRuleTag>
    coords: { top: number; left: number; placeAbove: boolean; anchorX: number }
}) {
    const caretLeft = Math.max(16, Math.min(POPOVER_W - 16, coords.anchorX))
    return (
        <motion.div
            initial={{ opacity: 0, y: coords.placeAbove ? 6 : -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: coords.placeAbove ? 6 : -6, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            style={{
                position: 'fixed',
                top: coords.placeAbove ? undefined : coords.top,
                bottom: coords.placeAbove ? window.innerHeight - coords.top : undefined,
                left: coords.left,
                width: POPOVER_W,
                zIndex: 9999,
                pointerEvents: 'none',
            }}
            className={cn(
                'relative rounded-2xl border border-glass-border',
                'bg-gradient-to-br from-canvas-elevated via-canvas-elevated to-canvas-base/95',
                'shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.04)]',
                'backdrop-blur-xl overflow-hidden',
            )}
        >
            <div className="px-3.5 pt-3 pb-2 flex items-center gap-2">
                <span className="w-7 h-7 rounded-lg bg-accent-lineage/15 flex items-center justify-center shrink-0">
                    <Tags className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.4} />
                </span>
                <div className="leading-tight">
                    <div className="text-[13px] font-display font-semibold text-ink">
                        {all.length} display {all.length === 1 ? 'tag' : 'tags'}
                    </div>
                    <div className="text-[10px] text-ink-muted">applied to this entity</div>
                </div>
            </div>
            <div
                aria-hidden
                className="h-px"
                style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.08) 20%, rgba(255,255,255,0.08) 80%, transparent)' }}
            />
            <div className="px-3 py-2 flex flex-col gap-1.5 max-h-[240px] overflow-y-auto">
                {all.map((tag) => (
                    <div key={tag.id} className="flex items-center gap-2 min-w-0">
                        <span
                            className="w-4 h-4 rounded shrink-0 flex items-center justify-center"
                            style={{ backgroundColor: `${tag.color}26` }}
                        >
                            {tag.icon
                                ? <DynamicIcon name={tag.icon} className="w-2.5 h-2.5" style={{ color: tag.color }} />
                                : <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tag.color }} />}
                        </span>
                        <span className="text-[11.5px] text-ink truncate">{tag.name}</span>
                    </div>
                ))}
            </div>
            <Caret placeAbove={coords.placeAbove} left={caretLeft} />
        </motion.div>
    )
}


function Caret({ placeAbove, left }: { placeAbove: boolean; left: number }) {
    const common = { position: 'absolute' as const, left, transform: 'translateX(-50%)', width: 0, height: 0 }
    if (placeAbove) {
        return (
            <span aria-hidden style={{
                ...common, bottom: -7,
                borderLeft: '7px solid transparent', borderRight: '7px solid transparent',
                borderTop: '7px solid var(--nx-border-glass, rgba(255,255,255,0.12))',
                filter: 'drop-shadow(0 1px 0 rgba(0,0,0,0.4))',
            }} />
        )
    }
    return (
        <span aria-hidden style={{
            ...common, top: -7,
            borderLeft: '7px solid transparent', borderRight: '7px solid transparent',
            borderBottom: '7px solid var(--nx-border-glass, rgba(255,255,255,0.12))',
            filter: 'drop-shadow(0 -1px 0 rgba(0,0,0,0.4))',
        }} />
    )
}
