/**
 * PlaygroundExperiments — the Playground's front page, for the person experimenting.
 *
 * In a team workspace the Overview leads with what waits on the reader and the
 * steps left to set it up. Neither means anything in the Playground: nobody joins
 * it to run it, they come to try something. So it leads with their own work — the
 * graphs they started and the views they built — how many more graphs they may
 * start, and the one button that starts the next.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Database, FlaskConical, Plus, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { View } from '@/services/viewApiService'
import { useAuthStore } from '@/store/auth'
import { usePlayground } from '@/hooks/usePlayground'
import { OverviewViewGrid } from './OverviewViewGrid'
import type { OverviewLayout } from './overviewLayout'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const FIRST_STEPS = [
    { title: 'Start a blank graph', detail: 'Pick a starter data model — it decides what kinds of things your graph holds.' },
    { title: 'Add things and how they connect', detail: 'Draw them on the canvas, or bring them in from a file.' },
    { title: 'Explore it in a view', detail: 'A map, a hierarchy or a table — share it here when you’re ready.' },
]

export function PlaygroundExperiments({ workspace, views, layout = 'cards', onNewGraph, onOpenGraph }: {
    workspace: WorkspaceResponse
    views: View[]
    /** How the Overview lays out views: the reader's choice. */
    layout?: OverviewLayout
    /** Start a blank graph on the Playground's sandbox provider. */
    onNewGraph?: (providerId?: string) => void
    onOpenGraph: (dataSourceId: string) => void
}) {
    const me = useAuthStore(s => s.user?.id)
    const info = usePlayground().data
    const queryClient = useQueryClient()

    const graphs = workspace.dataSources.filter(ds => !!me && ds.createdBy === me)
    const mine = views.filter(v => !!me && v.createdBy === me)
    const viewsOn = (dsId: string) => views.filter(v => v.dataSourceId === dsId).length

    // The quota is the server's count; read it again whenever a graph comes or goes.
    useEffect(() => {
        void queryClient.invalidateQueries({ queryKey: ['playground'] })
    }, [graphs.length, queryClient])

    const quota = info?.graphQuota ?? 0
    const used = info?.graphsUsed ?? graphs.length
    const full = quota > 0 && used >= quota
    const start = onNewGraph && !full ? () => onNewGraph(info?.sandboxProviderId ?? undefined) : undefined

    return (
        <section
            aria-labelledby="experiments-title"
            className="relative overflow-hidden rounded-3xl border border-violet-500/20 bg-canvas-elevated p-5 sm:p-6"
        >
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.07] via-transparent to-fuchsia-500/[0.05]" />
            <div className="relative">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3 min-w-0">
                        <span className="w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-md shadow-violet-500/20 shrink-0">
                            <FlaskConical className="w-5 h-5" aria-hidden />
                        </span>
                        <div className="min-w-0">
                            <h2 id="experiments-title" className="font-display text-lg font-bold text-ink">Your experiments</h2>
                            <p className="text-sm text-ink-secondary">
                                What you build here is yours — only you see it until you share it with the Playground.
                            </p>
                        </div>
                    </div>
                    {onNewGraph && (
                        <button
                            type="button"
                            onClick={start}
                            disabled={!start}
                            title={full ? 'You’ve used all your graphs — delete one you’re done with to start another.' : undefined}
                            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 disabled:opacity-50 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50"
                        >
                            <Plus className="w-4 h-4" aria-hidden /> Start a new graph
                        </button>
                    )}
                </div>

                {quota > 0 && (
                    <div className="mt-5">
                        <div className="flex items-baseline justify-between gap-3 text-xs">
                            <span className="font-semibold text-ink">{used} of {quota} graphs used</span>
                            <span className={cn(full ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-ink-muted')}>
                                {full ? 'Delete one you’re done with to start another' : `${quota - used} more you can start · experiments don’t expire`}
                            </span>
                        </div>
                        <div
                            role="meter" aria-label="Graphs used" aria-valuemin={0} aria-valuemax={quota} aria-valuenow={used}
                            className="mt-2 flex gap-1"
                        >
                            {Array.from({ length: quota }, (_, i) => (
                                <span
                                    key={i}
                                    className={cn(
                                        'h-2 flex-1 rounded-full',
                                        i < used
                                            ? full ? 'bg-amber-500' : 'bg-gradient-to-r from-violet-500 to-fuchsia-500'
                                            : 'bg-black/[0.06] dark:bg-white/[0.08]',
                                    )}
                                />
                            ))}
                        </div>
                    </div>
                )}

                {graphs.length === 0 ? (
                    <ol className="mt-5 grid gap-3 sm:grid-cols-3">
                        {FIRST_STEPS.map((s, i) => (
                            <li key={s.title} className="rounded-2xl border border-glass-border bg-canvas/60 p-4">
                                <span className="inline-flex w-6 h-6 items-center justify-center rounded-full bg-violet-500/10 text-xs font-bold text-violet-600 dark:text-violet-300">{i + 1}</span>
                                <p className="mt-2 text-sm font-semibold text-ink">{s.title}</p>
                                <p className="mt-0.5 text-xs text-ink-muted">{s.detail}</p>
                            </li>
                        ))}
                    </ol>
                ) : (
                    <div className="mt-5 space-y-4">
                        <ul aria-label="Your graphs" className="grid gap-2 sm:grid-cols-2">
                            {graphs.map(ds => (
                                <li key={ds.id}>
                                    <button
                                        type="button"
                                        onClick={() => onOpenGraph(ds.id)}
                                        className="group flex w-full items-center gap-3 rounded-2xl border border-glass-border bg-canvas/60 p-3 text-left hover:border-violet-500/40 hover:shadow-md hover:shadow-violet-500/10 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
                                    >
                                        <span className="w-9 h-9 rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300 flex items-center justify-center shrink-0">
                                            <Database className="w-4 h-4" aria-hidden />
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-semibold text-ink">{ds.label || ds.graphName || 'Untitled graph'}</span>
                                            <span className="block text-[11px] text-ink-muted">{viewsOn(ds.id) ? plural(viewsOn(ds.id), 'view') : 'No views yet'}</span>
                                        </span>
                                        <ArrowRight className="w-4 h-4 text-ink-muted opacity-0 group-hover:opacity-100 transition" aria-hidden />
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {mine.length > 0 && (
                            <div>
                                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                                    <Sparkles className="w-3.5 h-3.5 text-fuchsia-500" aria-hidden /> Your views
                                </p>
                                <OverviewViewGrid wsId={workspace.id} views={mine.slice(0, 4)} layout={layout}
                                    meta={v => v.visibility === 'private' ? 'Only you' : 'Shared in the Playground'} />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
    )
}
