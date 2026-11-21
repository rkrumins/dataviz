/**
 * BuilderChecklist — "Your first steps" in the Playground: the path from a first graph to a
 * change of one's own published, ticked from what the reader really did.
 *
 *   * made a graph — their graphs here (the server's count first);
 *   * made a view of their own — one they created themselves;
 *   * changed something in a draft — their open drafts here (`/views/me/drafts`);
 *   * sent a change for review — their reviews here (`/review-inbox?author=<them>`);
 *   * described their data — details they saved on a graph of theirs (metadata `updatedBy`);
 *   * published a change — a review of theirs merged, or their own tick (a direct publish leaves
 *     no signal to read).
 *
 * A sample or an import makes views, a draft and a review on the reader's behalf in the same
 * request as the graph: anything made within a couple of minutes of its graph is the starter's,
 * not the reader's, and ticks nothing. A step once done stays done in this browser (a published
 * draft leaves the drafts list), and the whole list goes once everything is ticked, or when its
 * reader hides it. Each step links to how to do it.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { ArrowUpRight, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { View } from '@/services/viewApiService'
import { DATA_SOURCE_METADATA_FEATURE, dataSourceMetadataService } from '@/services/dataSourceMetadataService'
import { metadataKey } from '@/hooks/useDataSourceMetadata'
import { useMyDrafts } from '@/hooks/useMyDrafts'
import { usePlayground } from '@/hooks/usePlayground'
import { useReviewInbox } from '@/features/versioning/hooks/useVersioning'
import { useAuthStore } from '@/store/auth'
import { useFeature } from '@/store/features'

/** Made this soon after its graph, it was made with it — by a sample or an import. */
export const STARTER_WINDOW_MS = 2 * 60_000
/** The most drafts `/views/me/drafts` lists. */
const DRAFTS = 25

type StepId = 'graph' | 'view' | 'draft' | 'review' | 'describe' | 'publish'

interface Step {
    id: StepId
    label: string
    detail: string
    /** Where the guide says how. */
    guide: string
    done: boolean
}

interface Memory { done: StepId[]; dismissed: boolean }

const keyOf = (wsId: string, me: string) => `nx-playground-first-steps:${wsId}:${me}`

function readMemory(key: string): Memory {
    try {
        const v = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<Memory> | null
        return { done: Array.isArray(v?.done) ? v.done : [], dismissed: v?.dismissed === true }
    } catch {
        return { done: [], dismissed: false }
    }
}

function writeMemory(key: string, memory: Memory) {
    try { window.localStorage.setItem(key, JSON.stringify(memory)) } catch { /* kept for this visit only */ }
}

export function BuilderChecklist({ workspace, views, className }: { workspace: WorkspaceResponse; views: View[]; className?: string }) {
    const me = useAuthStore(s => s.user?.id)
    if (!me) return null
    return <Checklist key={`${workspace.id}:${me}`} me={me} workspace={workspace} views={views} className={className} />
}

function Checklist({ me, workspace, views, className }: { me: string; workspace: WorkspaceResponse; views: View[]; className?: string }) {
    const wsId = workspace.id
    const key = keyOf(wsId, me)
    const [memory, setMemory] = useState(() => readMemory(key))
    const remember = (next: Memory) => { setMemory(next); writeMemory(key, next) }

    const versioning = useFeature('versioningEnabled')
    const metadataOn = useFeature(DATA_SOURCE_METADATA_FEATURE)
    const graphsUsed = usePlayground().data?.graphsUsed ?? 0
    const graphs = workspace.dataSources.filter(ds => ds.createdBy === me)
    const bornAt = new Map(workspace.dataSources.map(ds => [ds.id, ds.createdAt]))
    const viewSource = new Map(views.map(v => [v.id, v.dataSourceId]))
    /** Made by the reader, not with its graph. Unknown either side: theirs. */
    const theirs = (at?: string | null, dsId?: string | null) => {
        const born = dsId ? bornAt.get(dsId) : undefined
        return !at || !born || Date.parse(at) - Date.parse(born) > STARTER_WINDOW_MS
    }

    const drafts = useMyDrafts(DRAFTS).data ?? []
    const inbox = versioning ? wsId : undefined
    const open = useReviewInbox(inbox, { queue: 'open', author: me }).data?.pages[0]?.items ?? []
    const closed = useReviewInbox(inbox, { queue: 'done', author: me }).data?.pages[0]?.items ?? []
    const details = useQueries({
        queries: graphs.map(ds => ({
            queryKey: metadataKey(wsId, ds.id),
            queryFn: () => dataSourceMetadataService.get(wsId, ds.id),
            enabled: metadataOn,
            staleTime: 60_000,
        })),
    })

    const live: Record<StepId, boolean> = {
        graph: graphs.length > 0 || graphsUsed > 0,
        view: views.some(v => v.createdBy === me && theirs(v.createdAt, v.dataSourceId)),
        draft: drafts.some(d => d.workspaceId === wsId && theirs(d.createdAt, viewSource.get(d.viewId))),
        review: [...open, ...closed].some(pr => theirs(pr.createdAt, pr.targetDataSourceId)),
        describe: details.some(q => q.data?.updatedBy?.id === me && theirs(q.data.updatedAt, q.data.dataSourceId)),
        publish: closed.some(pr => pr.status === 'merged'),
    }
    const isDone = (id: StepId) => live[id] || memory.done.includes(id)

    // Done once, done for good: a draft published leaves the drafts list, and that is progress.
    const newlyDone = (Object.keys(live) as StepId[]).filter(id => live[id] && !memory.done.includes(id))
    const newlyKey = newlyDone.join(',')
    useEffect(() => {
        if (!newlyKey) return
        const saved = readMemory(key)
        writeMemory(key, { ...saved, done: [...new Set([...saved.done, ...(newlyKey.split(',') as StepId[])])] })
    }, [key, newlyKey])

    const plan: Omit<Step, 'done'>[] = [
        { id: 'graph', label: 'Make a graph', detail: 'Start from a sample, bring your own data, or start blank.', guide: '/guide/playground#start' },
        { id: 'view', label: 'Make a view of your own', detail: 'Another way to look at a graph — a graph, a hierarchy or a context view.', guide: '/guide/playground#views' },
        { id: 'draft', label: 'Change something in a draft', detail: 'Edit on the canvas. Your changes wait in a draft until you publish them.', guide: '/guide/playground#edit-in-a-draft' },
        { id: 'review', label: 'Send a change for review', detail: 'Ask someone to look first — the example review of a sample shows how.', guide: '/guide/playground#change-control' },
        ...(metadataOn ? [{ id: 'describe' as const, label: 'Describe your data', detail: 'Say what a graph holds and where it comes from, in its details.', guide: '/guide/playground#describe-your-data' }] : []),
        { id: 'publish', label: 'Publish a change', detail: 'Make a draft the live version. Graphs you made are yours to publish.', guide: '/guide/playground#publish-your-own' },
    ]
    const steps: Step[] = plan.map(s => ({ ...s, done: isDone(s.id) }))

    const done = steps.filter(s => s.done).length
    if (memory.dismissed || done === steps.length) return null
    const next = steps.find(s => !s.done)

    return (
        <section aria-labelledby="first-steps-title" data-tour="playground-checklist" className={cn('rounded-2xl border border-glass-border bg-canvas/60 p-4', className)}>
            <div className="flex items-start gap-3">
                <ProgressRing done={done} total={steps.length} />
                <div className="min-w-0 flex-1">
                    <h3 id="first-steps-title" className="text-sm font-semibold text-ink">Your first steps</h3>
                    <p className="text-xs text-ink-muted">
                        {done} of {steps.length} done · from a first graph to a change of your own, published
                    </p>
                </div>
                <button type="button" onClick={() => remember({ ...memory, dismissed: true })} aria-label="Hide your first steps"
                    className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40">
                    <X className="w-4 h-4" />
                </button>
            </div>
            <ol className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {steps.map((s, i) => {
                    const isNext = s.id === next?.id
                    return (
                        <li key={s.id} className={cn(
                            'flex items-start gap-2.5 rounded-xl px-2.5 py-2',
                            isNext && 'bg-canvas-elevated border border-violet-500/25 shadow-sm shadow-violet-500/5',
                        )}>
                            <span aria-hidden className={cn(
                                'mt-px flex w-5 h-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                                s.done ? 'bg-emerald-500 text-white' : isNext ? 'bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white' : 'bg-black/[0.06] dark:bg-white/[0.08] text-ink-muted',
                            )}>
                                {s.done ? <Check className="w-3 h-3" strokeWidth={3} /> : i + 1}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className={cn('block text-xs font-semibold', s.done ? 'text-ink-muted line-through decoration-ink-muted/40' : 'text-ink')}>
                                    {s.label}<span className="sr-only">{s.done ? ' — done' : ''}</span>
                                </span>
                                {!s.done && <span className="block text-[11px] leading-snug text-ink-muted">{s.detail}</span>}
                                {!s.done && (
                                    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                                        <Link to={s.guide} className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-300"
                                            aria-label={`How to: ${s.label.toLowerCase()}`}>
                                            How <ArrowUpRight className="w-3 h-3" aria-hidden />
                                        </Link>
                                        {s.id === 'publish' && (
                                            <button type="button" onClick={() => remember({ ...memory, done: [...memory.done, 'publish'] })}
                                                className="text-[11px] font-semibold text-ink-secondary hover:text-ink hover:underline">
                                                I’ve published one
                                            </button>
                                        )}
                                    </span>
                                )}
                            </span>
                        </li>
                    )
                })}
            </ol>
        </section>
    )
}

/** How far along, as a ring: emerald once everything is done, the Playground's colours until then. */
function ProgressRing({ done, total }: { done: number; total: number }) {
    const r = 15
    const c = 2 * Math.PI * r
    const pct = total ? done / total : 0
    return (
        <span role="progressbar" aria-label="First steps done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
            className="relative flex w-10 h-10 shrink-0 items-center justify-center">
            <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
                <defs>
                    <linearGradient id="first-steps-ring" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stopColor="#8b5cf6" />
                        <stop offset="100%" stopColor="#d946ef" />
                    </linearGradient>
                </defs>
                <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3.5" className="stroke-black/[0.07] dark:stroke-white/[0.1]" />
                {/* Nothing done draws nothing: a round cap on an empty arc is a stray dot. */}
                {done > 0 && (
                    <circle cx="18" cy="18" r={r} fill="none" strokeWidth="3.5" strokeLinecap="round" stroke="url(#first-steps-ring)"
                        strokeDasharray={`${c * pct} ${c}`} className="transition-[stroke-dasharray] duration-500" />
                )}
            </svg>
            <span className="text-[11px] font-bold tabular-nums text-ink">{done}/{total}</span>
        </span>
    )
}
