/**
 * SampleGallery — "Start from a sample", in the Playground.
 *
 * A blank canvas asks someone to know already what a graph is for. A sample shows them: a
 * realistic graph of their own — a retail data pipeline, a customer 360 — with saved searches
 * and an example change waiting for review. Start opens a small sheet asking which canvases it
 * opens with: its Context View always, and a Graph view and a Hierarchy view if they want them
 * (`CanvasChoice`). It then opens the Context View, offering the canvas tour and that review. It
 * is one of their graphs, so the quota holds it as it holds a blank one, and it is theirs to
 * change (backend `endpoints/playground.py`).
 */
import { useCallback, useEffect, useId, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, CircleAlert, Loader2, WandSparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { DynamicIcon, viewTypeIconComponent, viewTypeMeta } from '@/lib/viewUtils'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications, type NotificationAction } from '@/components/ui/notifications'
import { useFeature } from '@/store/features'
import { usePlaygroundSamples, useStartSample } from '@/hooks/usePlayground'
import type { PlaygroundSample, PlaygroundView } from '@/services/playgroundService'
import { CanvasChoice } from './CanvasChoice'
import { useCanvasChoice } from './canvasChoiceModel'

/** A sample's colour name → its icon tile. */
const TILES: Record<string, string> = {
    amber: 'from-amber-400 to-orange-500 shadow-amber-500/25',
    sky: 'from-sky-400 to-indigo-500 shadow-sky-500/25',
    emerald: 'from-emerald-400 to-teal-500 shadow-emerald-500/25',
}
const DEFAULT_TILE = 'from-violet-500 to-fuchsia-500 shadow-violet-500/25'
const FULL = 'You’ve used all your graphs — delete one you’re done with to start a sample.'
const PRIMARY = 'inline-flex h-9 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 disabled:hover:brightness-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50'

export function SampleGallery({ workspaceId, className, ref }: {
    workspaceId: string
    className?: string
    /** The gallery, for "Start from a sample" to scroll to. */
    ref?: Ref<HTMLElement>
}) {
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const toursOn = useFeature('toursEnabled')
    const catalogue = usePlaygroundSamples().data
    const start = useStartSample(workspaceId)
    /** The sample whose canvases are being chosen. */
    const [picking, setPicking] = useState<PlaygroundSample | null>(null)
    // Stable, so the sheet's focus handling doesn't start over as its sample begins: not while
    // the sample is being made, which leaving would hide.
    const pending = useRef(false)
    useEffect(() => { pending.current = start.isPending })
    const closeSheet = useCallback(() => { if (!pending.current) setPicking(null) }, [])

    if (!catalogue?.samples.length) return null
    const full = catalogue.quotaLeft <= 0

    const begin = (sample: PlaygroundSample, views: PlaygroundView[]) => start.mutate({ sampleId: sample.id, views }, {
        onSuccess: (made) => {
            setPicking(null)
            // The ways on from here: the canvas tour, and the change waiting for review — the
            // review itself, else its draft, on its Graph view or else its Context View (an older
            // server offers neither).
            const next: NotificationAction[] = []
            if (toursOn) next.push({ label: 'Take the tour', onClick: () => navigate(`/views/${made.viewId}?tour=canvas-lineage`) })
            const example = made.reviewId
                ? `/workspaces/${workspaceId}/reviews/${made.reviewId}`
                : made.draftId && made.viewIds ? `/views/${made.viewIds.graph ?? made.viewId}?branch=${made.draftId}` : null
            if (example) next.push({ label: 'See the example review', onClick: () => navigate(example) })
            notify('success', `“${sample.title}” is ready — explore it, then make it your own.`,
                next.length ? next : undefined, next.length ? 12_000 : undefined)
            navigate(`/views/${made.viewId}`)
        },
        onError: (err) => notify('error', err instanceof Error && err.message
            ? err.message
            : 'Couldn’t start that sample. Try again in a moment.'),
    })

    return (
        <section ref={ref} aria-labelledby="samples-title" className={cn('scroll-mt-24', className)}>
            <h3 id="samples-title" tabIndex={-1} className="flex items-center gap-1.5 text-sm font-semibold text-ink outline-none">
                <WandSparkles className="w-4 h-4 text-violet-500" aria-hidden /> Start from a sample
            </h3>
            <p className="mt-0.5 text-xs text-ink-muted">
                A ready-made graph to explore and change: a Context View, and a Graph view or a Hierarchy if you want them, saved searches, and an example change waiting for review. Each one counts as one of your graphs.
            </p>
            {full && (
                <p className="mt-2 inline-flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                    <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden /> {FULL}
                </p>
            )}
            <ul aria-label="Samples" className="mt-3 grid gap-3 sm:grid-cols-3">
                {catalogue.samples.map(s => {
                    const layout = viewTypeMeta(s.viewType)
                    const LayoutIcon = viewTypeIconComponent(s.viewType)
                    return (
                        <li
                            key={s.id}
                            className="flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated p-4 shadow-sm transition hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-500/10"
                        >
                            <div className="flex items-start justify-between gap-2">
                                <span className={cn('flex w-10 h-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', TILES[s.color] ?? DEFAULT_TILE)}>
                                    <DynamicIcon name={s.icon} className="w-5 h-5" />
                                </span>
                                <span title={layout.what} className="inline-flex items-center gap-1 rounded-full border border-glass-border bg-canvas px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                                    <LayoutIcon className="w-3 h-3" aria-hidden /> {/\bview$/i.test(layout.label) ? layout.label : `${layout.label} view`}
                                </span>
                            </div>
                            <h4 className="mt-3 text-sm font-semibold text-ink">{s.title}</h4>
                            <p className="mt-1 flex-1 text-xs text-ink-secondary">{s.description}</p>
                            <p className="mt-3 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] text-ink-muted">
                                <span><span className="font-semibold text-ink">{s.nodeCount}</span> things</span>
                                <span><span className="font-semibold text-ink">{s.edgeCount}</span> connections</span>
                                <span title={s.entityTypes.join(', ')}>
                                    <span className="font-semibold text-ink">{s.entityTypes.length}</span> {s.entityTypes.length === 1 ? 'type' : 'types'}
                                </span>
                            </p>
                            <button
                                type="button"
                                onClick={() => setPicking(s)}
                                disabled={full || start.isPending}
                                aria-haspopup="dialog"
                                aria-label={`Start ${s.title}`}
                                title={full ? FULL : undefined}
                                className={cn(PRIMARY, 'mt-4 w-full disabled:opacity-50 disabled:shadow-none')}
                            >
                                Start <ArrowRight className="w-4 h-4" aria-hidden />
                            </button>
                        </li>
                    )
                })}
            </ul>
            {picking && (
                <StartSheet sample={picking} busy={start.isPending} quotaLeft={catalogue.quotaLeft}
                    onStart={(views) => begin(picking, views)} onClose={closeSheet} />
            )}
        </section>
    )
}

/** The canvases a sample opens with, chosen before it is made: compact, over the gallery. */
function StartSheet({ sample, busy, quotaLeft, onStart, onClose }: {
    sample: PlaygroundSample
    busy: boolean
    quotaLeft: number
    onStart: (views: PlaygroundView[]) => void
    /** Keep it stable: the sheet's focus handling follows it. */
    onClose: () => void
}) {
    const ref = useModalA11y(true, onClose)
    const titleId = useId()
    const choice = useCanvasChoice(sample.hierarchy === null
        ? { why: 'This sample has nothing nested in anything else to show as a hierarchy.' }
        : { shows: sample.hierarchy ?? 'What holds what, as a tree you open and close' })
    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div className="fixed inset-0 z-[61] flex items-end justify-center p-3 sm:items-center sm:p-6 pointer-events-none">
                <motion.div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    tabIndex={-1}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={MOTION.fadeIn}
                    className="pointer-events-auto w-full max-w-md rounded-3xl border border-glass-border bg-canvas-elevated shadow-2xl outline-none"
                >
                    <div className="flex items-start gap-3 p-5 pb-3">
                        <span className={cn('flex w-10 h-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', TILES[sample.color] ?? DEFAULT_TILE)}>
                            <DynamicIcon name={sample.icon} className="w-5 h-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h2 id={titleId} className="font-display text-base font-bold text-ink">Start “{sample.title}”</h2>
                            <p className="text-xs text-ink-secondary">Choose the canvases it opens with.</p>
                        </div>
                        <button type="button" onClick={onClose} disabled={busy} aria-label="Close"
                            className="rounded-lg p-1 text-ink-muted hover:bg-black/5 hover:text-ink disabled:opacity-40 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                            <X className="w-4 h-4" aria-hidden />
                        </button>
                    </div>
                    <CanvasChoice choice={choice} compact className="px-5" />
                    <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-glass-border px-5 py-4">
                        <p className="mr-auto text-[11px] text-ink-muted">Counts as one of your graphs · {quotaLeft} left</p>
                        <button type="button" onClick={onClose} disabled={busy}
                            className="inline-flex h-9 items-center rounded-xl px-3.5 text-sm font-semibold text-ink-muted hover:bg-black/[0.04] hover:text-ink disabled:opacity-40 dark:hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                            Cancel
                        </button>
                        <button type="button" onClick={() => onStart(choice.views)} disabled={busy} aria-busy={busy || undefined}
                            className={cn(PRIMARY, busy && 'cursor-wait')}>
                            {busy
                                ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Starting…</>
                                : <>Start sample <ArrowRight className="w-4 h-4" aria-hidden /></>}
                        </button>
                    </div>
                </motion.div>
            </div>
        </>,
        document.body,
    )
}
