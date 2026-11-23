/**
 * PlaygroundExperiments — the Playground's front page, for the person experimenting.
 *
 * In a team workspace the Overview leads with what waits on the reader and the
 * steps left to set it up. Neither means anything in the Playground: nobody joins
 * it to run it, they come to try something. So it leads with their own work — the
 * graphs they started and the views they built — how many more graphs they may
 * start, and the three ways to start the next: explore a sample, bring their own
 * data, or start blank. Then the samples themselves, and their first steps — from a
 * first graph to a change of their own, published.
 *
 * `?start=samples` arrives at the samples and `?start=import` opens Bring your own
 * data: where the View wizard's blank path sends someone with no data model to start from.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ArrowRightLeft, Database, FilePlus, FlaskConical, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { View } from '@/services/viewApiService'
import { useAuthStore } from '@/store/auth'
import { useFeature } from '@/store/features'
import { usePlayground, usePlaygroundSamples } from '@/hooks/usePlayground'
import { SampleGallery } from '@/components/playground/SampleGallery'
import { PlaygroundStarts } from '@/components/playground/PlaygroundStarts'
import { YourDataModels } from '@/components/playground/YourDataModels'
import { BringYourOwnData } from '@/components/playground/BringYourOwnData'
import { BuilderChecklist } from '@/components/playground/BuilderChecklist'
import { OverviewViewGrid } from './OverviewViewGrid'
import type { OverviewLayout } from './overviewLayout'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function PlaygroundExperiments({ workspace, views, layout = 'cards', onNewGraph, onOpenGraph, onMoveGraph }: {
    workspace: WorkspaceResponse
    views: View[]
    /** How the Overview lays out views: the reader's choice. */
    layout?: OverviewLayout
    /** Start a blank graph on the Playground's sandbox provider. */
    onNewGraph?: (providerId?: string) => void
    onOpenGraph: (dataSourceId: string) => void
    /** Take one of the reader's graphs, with its views, into a workspace of theirs (or ask to). */
    onMoveGraph?: (dataSourceId: string, label: string) => void
}) {
    const me = useAuthStore(s => s.user?.id)
    const info = usePlayground().data
    const samples = usePlaygroundSamples().data
    const queryClient = useQueryClient()
    // A graph from files is a blank graph too: it needs what blank graphs need.
    const blankModels = useFeature('blankModelsEnabled')
    const versioning = useFeature('versioningEnabled')
    const [importing, setImporting] = useState(false)
    const closeImport = useCallback(() => setImporting(false), [])
    const gallery = useRef<HTMLElement>(null)
    const [params, setParams] = useSearchParams()
    const asked = params.get('start')

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
    const startBlank = onNewGraph ? () => onNewGraph(info?.sandboxProviderId ?? undefined) : undefined
    // Starting a graph is for someone who may (`onNewGraph`); samples, once there are some.
    const hasSamples = !!onNewGraph && !!samples?.samples.length
    const showSamples = useCallback(() => {
        gallery.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        gallery.current?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })
    }, [])

    // Sent here to start (`?start=samples|import`): do it once what it needs is here, then forget it.
    const [answered, setAnswered] = useState<string | null>(null)
    if (asked !== answered) {
        setAnswered(asked)
        if (asked === 'import') setImporting(true)
    }
    useEffect(() => {
        if (asked !== 'samples' && asked !== 'import') return
        if (asked === 'samples' && !hasSamples) return
        if (asked === 'samples') showSamples()
        setParams(prev => { const next = new URLSearchParams(prev); next.delete('start'); return next }, { replace: true })
    }, [asked, hasSamples, showSamples, setParams])

    const starts = (className: string) => (
        <PlaygroundStarts
            first={graphs.length === 0}
            full={full}
            onSample={hasSamples ? showSamples : undefined}
            onImport={onNewGraph && blankModels && versioning ? () => setImporting(true) : undefined}
            onBlank={startBlank}
            className={className}
        />
    )

    return (
        <section
            aria-labelledby="experiments-title"
            data-tour="playground-experiments"
            className="relative overflow-hidden rounded-3xl border border-violet-500/20 bg-canvas-elevated p-5 sm:p-6"
        >
            <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.07] via-transparent to-fuchsia-500/[0.05]" />
            <div className="relative">
                <div className="flex items-start gap-3 min-w-0">
                    <span className="w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white flex items-center justify-center shadow-md shadow-violet-500/20 shrink-0">
                        <FlaskConical className="w-5 h-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                        <h2 id="experiments-title" className="font-display text-lg font-bold text-ink">Your experiments</h2>
                        <p className="text-sm text-ink-secondary">
                            Shared with everyone in the Playground — make one private any time. Only you can change what you made.
                        </p>
                    </div>
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
                    <>
                        {/* Before their first graph: the ways to start, then the samples that show what one is for. */}
                        {starts('mt-5')}
                        {onNewGraph && <SampleGallery ref={gallery} workspaceId={workspace.id} className="mt-5" />}
                    </>
                ) : (
                    <div className="mt-5 space-y-4">
                        <ul aria-label="Your graphs" className="grid gap-2 sm:grid-cols-2">
                            {graphs.map(ds => (
                                <li key={ds.id} className="group flex items-center rounded-2xl border border-glass-border bg-canvas/60 hover:border-violet-500/40 hover:shadow-md hover:shadow-violet-500/10 transition">
                                    <button
                                        type="button"
                                        onClick={() => onOpenGraph(ds.id)}
                                        className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
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
                                    {/* Add more data: its Context View, with the import open in a draft. */}
                                    {(() => {
                                        const context = views.find(v => v.dataSourceId === ds.id && v.viewType === 'reference')
                                        return context && (
                                            <Link to={`/views/${context.id}?import=1`} title="Add more data from a file, in a draft"
                                                aria-label={`Add more data to ${ds.label || ds.graphName || 'this graph'}`}
                                                className="shrink-0 rounded-lg p-2 text-ink-muted hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                                                <FilePlus className="h-4 w-4" aria-hidden />
                                            </Link>
                                        )
                                    })()}
                                    {onMoveGraph && (
                                        <button type="button" onClick={() => onMoveGraph(ds.id, ds.label || ds.graphName || 'Untitled graph')}
                                            title="Move it, with its views, into one of your workspaces"
                                            aria-label={`Move ${ds.label || ds.graphName || 'this graph'} to a workspace`}
                                            className="mr-2 shrink-0 rounded-lg p-2 text-ink-muted hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                                            <ArrowRightLeft className="h-4 w-4" aria-hidden />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                        {mine.length > 0 && (
                            <div>
                                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                                    <Sparkles className="w-3.5 h-3.5 text-fuchsia-500" aria-hidden /> Your views
                                </p>
                                <OverviewViewGrid wsId={workspace.id} views={mine.slice(0, 4)} layout={layout}
                                    meta={v => v.visibility === 'private' ? 'Only you' : 'Shared with everyone here'} />
                            </div>
                        )}
                        {starts('border-t border-glass-border pt-4')}
                        {onNewGraph && <SampleGallery ref={gallery} workspaceId={workspace.id} />}
                    </div>
                )}
                <YourDataModels className="mt-5 border-t border-glass-border pt-4" />
                <BuilderChecklist workspace={workspace} views={views} className="mt-5" />
            </div>
            {importing && <BringYourOwnData workspaceId={workspace.id} onClose={closeImport} quotaLeft={samples?.quotaLeft ?? (quota > 0 ? quota - used : undefined)} />}
        </section>
    )
}
