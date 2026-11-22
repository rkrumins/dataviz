/**
 * SampleGallery — "Start from a sample", in the Playground.
 *
 * A blank canvas asks someone to know already what a graph is for. A sample shows them: one
 * click makes a realistic graph of their own — a retail data pipeline, a customer 360 — with a
 * Context View, a Graph view and a Hierarchy view on it, saved searches, and an example change
 * waiting for review; it opens the Context View, offering the canvas tour and that review. It is
 * one of their graphs, so the quota holds it as it holds a blank one, and it is theirs to change
 * (backend `endpoints/playground.py`).
 */
import type { Ref } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CircleAlert, Loader2, WandSparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DynamicIcon, viewTypeIconComponent, viewTypeMeta } from '@/lib/viewUtils'
import { useAppNotifications, type NotificationAction } from '@/components/ui/notifications'
import { useFeature } from '@/store/features'
import { usePlaygroundSamples, useStartSample } from '@/hooks/usePlayground'
import type { PlaygroundSample } from '@/services/playgroundService'

/** A sample's colour name → its icon tile. */
const TILES: Record<string, string> = {
    amber: 'from-amber-400 to-orange-500 shadow-amber-500/25',
    sky: 'from-sky-400 to-indigo-500 shadow-sky-500/25',
    emerald: 'from-emerald-400 to-teal-500 shadow-emerald-500/25',
}
const DEFAULT_TILE = 'from-violet-500 to-fuchsia-500 shadow-violet-500/25'
const FULL = 'You’ve used all your graphs — delete one you’re done with to start a sample.'

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

    if (!catalogue?.samples.length) return null
    const full = catalogue.quotaLeft <= 0

    const begin = (sample: PlaygroundSample) => start.mutate(sample.id, {
        onSuccess: (made) => {
            // The ways on from here: the canvas tour, and the change waiting for review on its
            // Graph view — the review itself, else its draft (an older server offers neither).
            const next: NotificationAction[] = []
            if (toursOn) next.push({ label: 'Take the tour', onClick: () => navigate(`/views/${made.viewId}?tour=canvas-lineage`) })
            const example = made.reviewId
                ? `/workspaces/${workspaceId}/reviews/${made.reviewId}`
                : made.draftId && made.viewIds?.graph ? `/views/${made.viewIds.graph}?branch=${made.draftId}` : null
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
                A ready-made graph to explore and change: a Context View, a Graph view and a Hierarchy, saved searches, and an example change waiting for review. Each one counts as one of your graphs.
            </p>
            {full && (
                <p className="mt-2 inline-flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                    <CircleAlert className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden /> {FULL}
                </p>
            )}
            <ul aria-label="Samples" className="mt-3 grid gap-3 sm:grid-cols-3">
                {catalogue.samples.map(s => {
                    const busy = start.isPending && start.variables === s.id
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
                                onClick={() => begin(s)}
                                disabled={full || start.isPending}
                                aria-busy={busy || undefined}
                                aria-label={`${busy ? 'Starting' : 'Start'} ${s.title}`}
                                title={full ? FULL : undefined}
                                className={cn(
                                    'mt-4 inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 disabled:hover:brightness-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
                                    // The one starting stays bright; the rest wait.
                                    busy ? 'cursor-wait' : 'disabled:opacity-50 disabled:shadow-none',
                                )}
                            >
                                {busy
                                    ? <><Loader2 className="w-4 h-4 animate-spin" aria-hidden /> Starting…</>
                                    : <>Start <ArrowRight className="w-4 h-4" aria-hidden /></>}
                            </button>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
