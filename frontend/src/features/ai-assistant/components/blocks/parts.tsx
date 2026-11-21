/**
 * The pieces every answer card is built from: its shell, a section's label, counts by type as
 * bars, an entity as a chip (hover for what it is and where; click to show it), and the evidence
 * and caveats line every card ends on — accuracy is the promise, so what a card could not see is
 * said on the card.
 */
import type { ComponentType, ReactNode } from 'react'
import { AlertTriangle, Info, ShieldCheck } from 'lucide-react'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { HoverTip } from '@/components/ui/HoverTip'
import { useEntityTypeLabel, useEntityVisual } from '@/hooks/useEntityVisual'
import { compact, exact } from '@/lib/formatMetric'
import { cn } from '@/lib/utils'
import type { Entity, TypeCount } from '../../api/types'
import { useAssistantActions, useMountedCanvasViewId } from '../../lib/useAssistantActions'

type Icon = ComponentType<{ className?: string }>

const TONE = {
    accent: 'bg-accent-lineage/10 text-accent-lineage',
    violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
    rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-300',
    neutral: 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.07]',
} as const

export type CardTone = keyof typeof TONE

export function CardShell({ icon: Glyph, tone = 'accent', title, meta, aside, footer, children, className, label }: {
    icon: Icon
    tone?: CardTone
    title: ReactNode
    meta?: ReactNode
    aside?: ReactNode
    footer?: ReactNode
    children?: ReactNode
    className?: string
    /** The card's accessible name, when `title` is not plain text. */
    label?: string
}) {
    return (
        <section
            aria-label={label ?? (typeof title === 'string' ? title : undefined)}
            className={cn('overflow-hidden rounded-xl border border-glass-border bg-canvas shadow-sm shadow-black/5', className)}
        >
            <header className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
                <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', TONE[tone])}>
                    <Glyph className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold leading-snug text-ink">{title}</h3>
                    {meta && <div className="mt-0.5 text-xs text-ink-muted">{meta}</div>}
                </div>
                {aside}
            </header>
            {children && <div className="space-y-3.5 px-3.5 pb-3.5">{children}</div>}
            {footer && (
                <footer className="flex flex-wrap items-center gap-1.5 border-t border-glass-border bg-black/[0.02] px-3 py-2 dark:bg-white/[0.02]">
                    {footer}
                </footer>
            )}
        </section>
    )
}

export function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
    return (
        <div className="mb-1.5 flex items-center justify-between gap-2">
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">{children}</h4>
            {aside}
        </div>
    )
}

/** A type's icon in its colour. */
export function TypeGlyph({ type, className }: { type: string; className?: string }) {
    const visual = useEntityVisual(type)
    return <DynamicIcon name={visual.icon} className={cn('h-3.5 w-3.5 shrink-0', className)} style={{ color: visual.color }} />
}

function TypeBar({ row, max }: { row: TypeCount; max: number }) {
    const color = useEntityVisual(row.type).color
    const share = max > 0 ? Math.max(0.03, row.count / max) : 0
    return (
        <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-secondary">
                <TypeGlyph type={row.type} />
                <span className="truncate">{row.label}</span>
            </span>
            <span className="text-xs font-semibold tabular-nums text-ink">{compact(row.count)}</span>
            <span aria-hidden className="col-span-2 h-1.5 overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.07]">
                <span className="block h-full origin-left rounded-full" style={{ width: `${share * 100}%`, backgroundColor: color }} />
            </span>
        </li>
    )
}

/** Counts by type, largest first, as bars against the largest. */
export function TypeBars({ rows, limit = 6 }: { rows: TypeCount[]; limit?: number }) {
    const sorted = [...rows].sort((a, b) => b.count - a.count)
    const shown = sorted.slice(0, limit)
    const rest = sorted.slice(limit).reduce((n, r) => n + r.count, 0)
    const max = shown[0]?.count ?? 0
    return (
        <ul className="space-y-2">
            {shown.map((r) => <TypeBar key={r.type} row={r} max={max} />)}
            {rest > 0 && <li className="text-xs text-ink-muted">and {exact(rest)} more of {sorted.length - limit} other {sorted.length - limit === 1 ? 'type' : 'types'}</li>}
        </ul>
    )
}

/**
 * An entity, as a chip. Hover says what it is and where it sits; a click shows it on the canvas
 * when that view's canvas is open, or opens it in its view otherwise.
 */
export function EntityChip({ entity, viewId, trailing, className }: {
    entity: Entity
    /** The view the answer read it in — where a click takes it. */
    viewId?: string
    trailing?: ReactNode
    className?: string
}) {
    const visual = useEntityVisual(entity.type)
    const typeLabel = useEntityTypeLabel(entity.type) ?? entity.type
    const actions = useAssistantActions()
    const mounted = useMountedCanvasViewId()
    const onCanvas = !!viewId && mounted === viewId
    const where = entity.path?.length ? entity.path.join(' › ') : null
    const body = (
        <>
            <DynamicIcon name={visual.icon} className="h-3 w-3 shrink-0" style={{ color: visual.color }} />
            <span className="truncate font-medium text-ink">{entity.name}</span>
            {trailing}
        </>
    )
    const chip = cn(
        'inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs leading-5',
        'border-glass-border bg-black/[0.03] dark:bg-white/[0.04]',
        className,
    )
    return (
        <HoverTip
            className="inline-flex max-w-full min-w-0"
            label={(
                <span className="block">
                    <span className="block font-semibold">{entity.name}</span>
                    <span className="block">{typeLabel}{where ? ` in ${where}` : ''}</span>
                </span>
            )}
            detail={onCanvas ? 'Click to show it on the canvas' : viewId ? 'Click to open it in its view' : undefined}
        >
            {viewId ? (
                <button
                    type="button"
                    onClick={() => actions.reveal(viewId, [entity.urn])}
                    aria-label={`${entity.name}, ${typeLabel}${onCanvas ? ' — show on the canvas' : ' — open in its view'}`}
                    className={cn(chip, 'transition-colors hover:border-accent-lineage/40 hover:bg-accent-lineage/5',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40')}
                >
                    {body}
                </button>
            ) : (
                <span className={chip}>{body}</span>
            )}
        </HoverTip>
    )
}

/** Several entities as chips, the first few, with how many more there are. */
export function EntityList({ items, viewId, limit = 8, total }: {
    items: Entity[]
    viewId?: string
    limit?: number
    /** All there are, when more than `items` were found. */
    total?: number
}) {
    const shown = items.slice(0, limit)
    const more = (total ?? items.length) - shown.length
    return (
        <div className="flex flex-wrap gap-1.5">
            {shown.map((e) => <EntityChip key={e.urn} entity={e} viewId={viewId} />)}
            {more > 0 && <span className="self-center text-xs text-ink-muted">+{exact(more)} more</span>}
        </div>
    )
}

export interface Caveat {
    tone: 'ok' | 'info' | 'warning'
    text: ReactNode
}

const CAVEAT_ICON = { ok: ShieldCheck, info: Info, warning: AlertTriangle } as const
const CAVEAT_TONE = {
    ok: 'text-emerald-600 dark:text-emerald-400',
    info: 'text-ink-muted',
    warning: 'text-amber-600 dark:text-amber-400',
} as const

/** What the answer rests on, and what it could not see. */
export function Caveats({ items, label = 'Evidence and caveats' }: { items: Caveat[]; label?: string }) {
    if (items.length === 0) return null
    return (
        <div>
            <SectionLabel>{label}</SectionLabel>
            <ul className="space-y-1">
                {items.map((c, i) => {
                    const Glyph = CAVEAT_ICON[c.tone]
                    return (
                        <li key={i} className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-secondary">
                            <Glyph className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', CAVEAT_TONE[c.tone])} aria-hidden />
                            <span>{c.text}</span>
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}
