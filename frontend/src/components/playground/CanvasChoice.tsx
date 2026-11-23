/**
 * CanvasChoice — which canvases a new Playground graph opens with.
 *
 * Every graph opens in its Context View: the layout built for reading a pipeline, and the one a
 * person edits in. A Graph view and a Hierarchy view are other ways of looking at the same data —
 * useful, but each is one more view in their list, so they're asked for rather than made for
 * everyone. A Hierarchy needs something to nest: a containment in the data model (a dashboard
 * holding its metrics). Without one, or while an administrator has withdrawn a layout, its card
 * says why it can't be chosen — and it is never sent, so the server never refuses the graph for it.
 *
 * One choice, two front doors: a step of Bring your own data, and the sheet a sample starts from
 * (`canvasChoiceModel.useCanvasChoice` holds it; `views` is what to send).
 */
import { useId } from 'react'
import { motion } from 'framer-motion'
import { Check, Info, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { DynamicIcon, layoutTypeIcon, viewTypeMeta } from '@/lib/viewUtils'
import { Badge } from '@/components/ui/Badge'
import { HoverTip } from '@/components/ui/HoverTip'
import type { PlaygroundView } from '@/services/playgroundService'
import type { CanvasChoiceState } from './canvasChoiceModel'

export function CanvasChoice({ choice, compact = false, className }: {
    choice: CanvasChoiceState
    /** Rows rather than cards, for a narrow sheet. */
    compact?: boolean
    className?: string
}) {
    const labelId = useId()
    const { chosen, blocked, hierarchy } = choice
    const extra = chosen.filter(v => !blocked[v])
    return (
        <div className={className}>
            <div role="group" aria-labelledby={labelId}
                className={cn('grid gap-2', compact ? 'grid-cols-1' : 'sm:grid-cols-3')}>
                <span id={labelId} className="sr-only">Canvases to make</span>
                <Card kind="reference" compact={compact} state="locked"
                    note={<Badge tone="accent" size="sm">Opens first</Badge>}
                    detail="Where you read the pipeline and make changes" />
                <Card kind="graph" compact={compact} state={blocked.graph ? 'blocked' : chosen.includes('graph') ? 'on' : 'off'}
                    reason={blocked.graph} onToggle={() => choice.toggle('graph')}
                    detail="The same things, laid out freely to explore how they connect" />
                <Card kind="hierarchy" compact={compact} state={blocked.hierarchy ? 'blocked' : chosen.includes('hierarchy') ? 'on' : 'off'}
                    reason={blocked.hierarchy} onToggle={() => choice.toggle('hierarchy')}
                    detail={'shows' in hierarchy ? hierarchy.shows : 'What holds what, as a tree you open and close'} />
            </div>
            <p aria-live="polite" className="mt-2 text-[11px] text-ink-muted">
                {extra.length
                    ? `You’ll get ${extra.length + 1} views: the Context View${extra.map(v => `, ${viewTypeMeta(v).label}`).join('')}.`
                    : 'Just the Context View for now.'}{' '}
                You can add more views later.
            </p>
        </div>
    )
}

function Card({ kind, state, compact, detail, note, reason, onToggle }: {
    kind: 'reference' | PlaygroundView
    /** `locked`: always made. `blocked`: can't be chosen, `reason` says why. */
    state: 'locked' | 'on' | 'off' | 'blocked'
    compact: boolean
    detail: string
    note?: React.ReactNode
    reason?: string | null
    onToggle?: () => void
}) {
    const reasonId = useId()
    const meta = viewTypeMeta(kind)
    const on = state === 'on' || state === 'locked'
    const body = (
        <>
            <span aria-hidden className={cn('flex w-9 h-9 shrink-0 items-center justify-center rounded-xl border', meta.iconBg)}>
                <DynamicIcon name={layoutTypeIcon(kind)} className="w-4 h-4" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold text-ink">{meta.label}</span>
                    {note}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-ink-secondary">{detail}</span>
                {state === 'blocked' && reason && (
                    <span id={reasonId} className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-amber-700 dark:text-amber-400">
                        <Info className="mt-px w-3 h-3 shrink-0" aria-hidden /> {reason}
                    </span>
                )}
            </span>
            <span aria-hidden className={cn(
                'flex w-5 h-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                !compact && 'sm:absolute sm:right-3 sm:top-3',
                on ? 'border-violet-500 bg-violet-500 text-white' : 'border-black/20 dark:border-white/20 bg-canvas-elevated',
                state === 'locked' && 'border-violet-500/40 bg-violet-500/15 text-violet-600 dark:text-violet-300',
            )}>
                {state === 'locked'
                    ? <Lock className="w-2.5 h-2.5" />
                    : on && <motion.span key="on" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={MOTION.fadeIn}>
                        <Check className="w-3 h-3" strokeWidth={3} />
                    </motion.span>}
            </span>
        </>
    )
    const frame = cn(
        'relative flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition',
        compact ? 'sm:p-3' : 'sm:flex-col sm:p-3.5',
        on ? 'border-violet-500/45 bg-violet-500/[0.06] shadow-md shadow-violet-500/10'
            : 'border-glass-border bg-canvas/60',
    )
    if (state === 'locked') {
        return (
            <HoverTip className="flex" label="Every graph opens in its Context View" detail="It’s where you read the pipeline and make your changes.">
                <div role="checkbox" aria-checked="true" aria-disabled="true" aria-label={`${meta.label}, opens first`} className={frame}>
                    {body}
                </div>
            </HoverTip>
        )
    }
    const button = (
        <button type="button" role="checkbox" aria-checked={state === 'on'} aria-disabled={state === 'blocked' || undefined}
            aria-describedby={state === 'blocked' && reason ? reasonId : undefined}
            onClick={state === 'blocked' ? undefined : onToggle}
            className={cn(frame,
                state === 'blocked'
                    ? 'cursor-not-allowed opacity-70'
                    : 'hover:-translate-y-px hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50')}>
            {body}
        </button>
    )
    return state === 'blocked' && reason
        ? <HoverTip className="flex" label={`${meta.label} isn’t available here`} detail={reason}>{button}</HoverTip>
        : button
}
