/**
 * Reviewing a data request — for the platform team, and a workspace's admins for its
 * requests: everything the requester said (what, from where, why, by when, who knows it)
 * and where it stands, and the answers. **Start** takes it on as yours; **Connect…** names
 * the data source it became — one of the workspace's, or one added there and then through
 * Add source — or marks it connected another way; **Decline** (the platform team's) says
 * why. A source's named Owner or Steward may connect it too, to a source they look after
 * and nothing else. Nobody answers their own request.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
    ArrowRight, CalendarClock, Check, Clock, Database, Hand, Loader2, MessageSquareText, Plus, Search, UserRound, X, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { workspaceService } from '@/services/workspaceService'
import { catalogService } from '@/services/catalogService'
import { providerService } from '@/services/providerService'
import { ontologyDefinitionService } from '@/services/ontologyDefinitionService'
import type { DataRequest } from '@/services/dataRequestsService'
import { useAuthStore, usePermission } from '@/store/auth'
import { AddDataSourceWizard } from '@/components/admin/workspace/AddDataSourceWizard'
import { dataRequestRefusal, useDataRequestActions, useFulfilRights, useIsPlatformTeam } from '@/hooks/useDataRequests'
import { DataRequestProgress } from './DataRequestProgress'
import { STATUS_LABEL, STATUS_PILL, URGENCY_BADGE, systemOf, urgencyOf } from './systems'
import { SystemTile } from './SystemTile'

type Mode = 'read' | 'connect' | 'decline'
/** No source named: connected some other way. */
const ELSEWHERE = ''

export function ReviewDataRequestDrawer({ request: listed, onClose }: { request: DataRequest; onClose: () => void }) {
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const actions = useDataRequestActions()
    const canDecline = useIsPlatformTeam()
    const [request, setRequest] = useState(listed)
    const [mode, setMode] = useState<Mode>('read')
    const [text, setText] = useState('')
    const [chosen, setChosen] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    // Add source is a dialog of its own: while it is open, Escape and Tab are its.
    const ref = useModalA11y(!adding, onClose)
    const [connected, setConnected] = useState(false)

    const wsId = request.workspaceId
    const rights = useFulfilRights(wsId)
    const meId = useAuthStore(s => s.user?.id)
    const mine = request.requestedBy === meId
    // An Owner or Steward who is not an admin connects it to a source of theirs, or not at all.
    const contactOnly = !rights.full
    const canAddSource = usePermission('workspace:datasource:manage', wsId) && !contactOnly
    const workspace = useQuery({
        queryKey: ['workspace', wsId],
        queryFn: () => workspaceService.get(wsId),
        enabled: mode === 'connect',
    })
    const sources = (workspace.data?.dataSources ?? []).filter(ds => !contactOnly || rights.contactSourceIds.includes(ds.id))

    const system = systemOf(request.system)
    const urgency = urgencyOf(request.urgency)
    const requester = request.requesterName || 'The requester'
    const open = request.status === 'pending' || request.status === 'in_progress'
    const busy = actions.start.isPending || actions.connect.isPending || actions.decline.isPending
    const failed = (e: unknown) => notify('error', dataRequestRefusal(e))

    const start = () => actions.start.mutate(request.id, {
        onSuccess: r => { setRequest(r); notify('success', `You’ve taken on “${r.title}”. ${requester} has been told.`) },
        onError: failed,
    })
    const connect = () => actions.connect.mutate(
        { id: request.id, dataSourceId: chosen || null, note: text.trim() || undefined },
        { onSuccess: r => { setRequest(r); setConnected(true) }, onError: failed },
    )
    const decline = () => actions.decline.mutate(
        { id: request.id, reason: text.trim() || undefined },
        { onSuccess: () => { notify('success', `Declined. ${requester} has been told.`); onClose() }, onError: failed },
    )

    // A source added from here is the one it became: pick it as soon as it's listed.
    const added = async (before: Set<string>) => {
        const fresh = (await workspace.refetch()).data?.dataSources.find(d => !before.has(d.id))
        if (fresh) setChosen(fresh.id)
    }

    if (adding) {
        return (
            <AddSourceForRequest workspaceId={wsId} workspaceName={request.workspaceName ?? undefined}
                onAdded={() => void added(new Set(sources.map(s => s.id)))} onClose={() => setAdding(false)} />
        )
    }

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="data-request-review-title" tabIndex={-1}
                className="fixed inset-y-0 right-0 z-[61] flex w-full max-w-xl flex-col border-l border-glass-border bg-canvas-elevated shadow-2xl outline-none">
                {/* Header */}
                <div className="relative overflow-hidden border-b border-glass-border p-5">
                    <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-indigo-500/[0.09] via-transparent to-violet-500/[0.06]" />
                    <div className="relative flex items-start gap-3">
                        <SystemTile system={request.system} size="lg" />
                        <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                                Data request{request.workspaceName ? ` · ${request.workspaceName}` : ''}
                            </p>
                            <h2 id="data-request-review-title" className="truncate font-display text-xl font-bold text-ink">{request.title}</h2>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                                <span>From {requester}</span><span aria-hidden>·</span>
                                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden /> {timeAgo(request.createdAt)}</span>
                                <span aria-hidden>·</span><span>{system.label}</span>
                                <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', STATUS_PILL[request.status])}>{STATUS_LABEL[request.status]}</span>
                                {open && URGENCY_BADGE[request.urgency] && (
                                    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', URGENCY_BADGE[request.urgency])}>{urgency.label}</span>
                                )}
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 space-y-5 overflow-y-auto custom-scrollbar p-5">
                    {connected ? (
                        <Connected request={request} onOpen={() => { onClose(); navigate(`/workspaces/${wsId}?tab=data&section=sources`) }} />
                    ) : (
                        <>
                            <div className="rounded-2xl border border-glass-border p-4">
                                <DataRequestProgress status={request.status} assigneeName={request.assigneeName} />
                            </div>
                            <Section icon={Search} title="What">
                                <p className="whitespace-pre-line text-sm text-ink">{request.details || <span className="text-ink-muted">Not described.</span>}</p>
                            </Section>
                            <Section icon={MessageSquareText} title="Why">
                                <p className="whitespace-pre-line text-sm text-ink">{request.purpose || <span className="text-ink-muted">Not given.</span>}</p>
                            </Section>
                            <Section icon={CalendarClock} title="When">
                                <p className="text-sm text-ink">{urgency.label} <span className="text-ink-muted">· {urgency.detail}</span></p>
                            </Section>
                            <Section icon={UserRound} title="People who know it">
                                {(request.contacts ?? []).length === 0 ? <p className="text-sm text-ink-muted">Nobody named — ask {requester}.</p> : (
                                    <ul className="flex flex-wrap gap-1.5">
                                        {(request.contacts ?? []).map(c => (
                                            <li key={c.id} className="rounded-full bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">{c.displayName || c.id}</li>
                                        ))}
                                    </ul>
                                )}
                            </Section>

                            {mode === 'connect' && (
                                <div className="space-y-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] p-4">
                                    <div role="radiogroup" aria-label="The data source it became" className="space-y-2">
                                        <p className="text-xs font-semibold text-ink-secondary">The data source it became</p>
                                        {workspace.isLoading && <p className="text-sm text-ink-muted">Loading the workspace’s sources…</p>}
                                        {sources.map(ds => (
                                            <Choice key={ds.id} on={chosen === ds.id} onPick={() => setChosen(ds.id)}
                                                title={ds.label || ds.graphName || ds.id} detail={ds.graphName && ds.label ? ds.graphName : undefined} />
                                        ))}
                                        {contactOnly ? (
                                            <p className="text-[11px] text-ink-muted">You can connect it to a source you look after as its Owner or a Steward.</p>
                                        ) : (
                                            <Choice on={chosen === ELSEWHERE} onPick={() => setChosen(ELSEWHERE)}
                                                title="Connected another way" detail="Not one of this workspace’s sources — or you’ll add it later." />
                                        )}
                                    </div>
                                    {canAddSource && (
                                        <button type="button" onClick={() => setAdding(true)}
                                            className="inline-flex items-center gap-1.5 rounded-xl border border-dashed border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/[0.06]">
                                            <Plus className="h-3.5 w-3.5" aria-hidden /> Add source to {request.workspaceName || 'the workspace'}
                                        </button>
                                    )}
                                    <label className="block">
                                        <span className="text-xs font-semibold text-ink-secondary">A note for {requester} (optional)</span>
                                        <textarea value={text} onChange={e => setText(e.target.value)} rows={2} maxLength={2000}
                                            placeholder="e.g. The ledger is in — the marts follow once the nightly load has run."
                                            className="input mt-1 w-full resize-none" />
                                    </label>
                                </div>
                            )}
                            {mode === 'decline' && (
                                <label className="block rounded-2xl border border-glass-border p-4">
                                    <span className="text-xs font-semibold text-ink-secondary">Why (optional, shown to them)</span>
                                    <textarea value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={2000} autoFocus
                                        placeholder="e.g. Finance Data already has these marts — ask to join it."
                                        className="input mt-1 w-full resize-none" />
                                </label>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                {!connected && open && mine && (
                    <p className="border-t border-glass-border p-4 text-center text-xs text-ink-muted">
                        You asked for this, so someone else takes it on and connects it.
                    </p>
                )}
                {!connected && open && !mine && (
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-glass-border p-4">
                        {mode === 'read' ? (
                            <>
                                {canDecline && (
                                    <button type="button" onClick={() => setMode('decline')} disabled={busy} className={GHOST}>
                                        <XCircle className="h-4 w-4" aria-hidden /> Decline
                                    </button>
                                )}
                                {request.status === 'pending' && rights.full && (
                                    <button type="button" onClick={start} disabled={busy} className={GHOST}>
                                        {actions.start.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Hand className="h-4 w-4" aria-hidden />}
                                        Start — assign me
                                    </button>
                                )}
                                <button type="button" onClick={() => { setMode('connect'); setText('') }} disabled={busy} className={CONNECT}>
                                    <Database className="h-4 w-4" aria-hidden /> Connect…
                                </button>
                            </>
                        ) : (
                            <>
                                <button type="button" onClick={() => { setMode('read'); setText(''); setChosen(null) }} disabled={busy} className={GHOST}>Back</button>
                                {mode === 'connect' && (
                                    <button type="button" onClick={connect} disabled={busy || chosen === null} className={CONNECT}>
                                        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />} Mark connected
                                    </button>
                                )}
                                {mode === 'decline' && (
                                    <button type="button" onClick={decline} disabled={busy} className={DANGER}>
                                        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Decline
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>
        </>,
        document.body,
    )
}

/** Add source, from the review: the workspace's own Add source wizard, on the lists its
 *  page reads (the same queries, so they come from cache when it was open). */
function AddSourceForRequest({ workspaceId, workspaceName, onAdded, onClose }: {
    workspaceId: string
    workspaceName?: string
    onAdded: () => void
    onClose: () => void
}) {
    const catalog = useQuery({ queryKey: ['catalog', 'list'], queryFn: () => catalogService.list(), staleTime: 5 * 60 * 1000 }).data
    const providers = useQuery({ queryKey: ['providers', 'list'], queryFn: () => providerService.list(), staleTime: 5 * 60 * 1000 }).data
    const ontologies = useQuery({ queryKey: ['ontology-defs', 'list'], queryFn: () => ontologyDefinitionService.list(), staleTime: 5 * 60 * 1000 }).data
    // What this workspace may use, as Data → Sources offers it.
    const items = useMemo(
        () => (catalog ?? []).filter(i => i.permittedWorkspaces.includes('*') || i.permittedWorkspaces.includes(workspaceId)),
        [catalog, workspaceId],
    )
    return (
        <AddDataSourceWizard isOpen workspaceId={workspaceId} workspaceName={workspaceName} onClose={onClose} onAdded={onAdded}
            catalogItems={items} providers={providers ?? []} ontologies={ontologies ?? []} />
    )
}

function Connected({ request, onOpen }: { request: DataRequest; onOpen: () => void }) {
    return (
        <div className="flex flex-col items-center py-6 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/25">
                <Check className="h-7 w-7" aria-hidden />
            </span>
            <h3 className="font-display text-xl font-bold text-ink">“{request.title}” is connected</h3>
            <p className="mt-2 text-sm text-ink-secondary">
                {request.dataSourceLabel ? `It’s in ${request.workspaceName || 'the workspace'} as ${request.dataSourceLabel}. ` : ''}
                {request.requesterName || 'The requester'} has been told.
            </p>
            <button type="button" onClick={onOpen} className={cn(CONNECT, 'mt-5')}>Open its sources <ArrowRight className="h-4 w-4" aria-hidden /></button>
        </div>
    )
}

function Choice({ on, onPick, title, detail }: { on: boolean; onPick: () => void; title: string; detail?: string }) {
    return (
        <button type="button" role="radio" aria-checked={on} onClick={onPick}
            className={cn('flex w-full items-center gap-3 rounded-xl border-2 px-3 py-2 text-left transition-colors',
                on ? 'border-emerald-500 bg-emerald-500/[0.06]' : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-emerald-500/40')}>
            <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2', on ? 'border-emerald-500 bg-emerald-500' : 'border-black/[0.20] dark:border-white/[0.25]')}>
                {on && <Check className="h-2.5 w-2.5 text-white" aria-hidden />}
            </span>
            <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-ink">{title}</span>
                {detail && <span className="block truncate text-[11px] text-ink-muted">{detail}</span>}
            </span>
        </button>
    )
}

function Section({ icon: Icon, title, children }: { icon: typeof Search; title: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
            </h3>
            {children}
        </section>
    )
}

const GHOST = 'inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-50'
const CONNECT = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-emerald-500 to-teal-500 shadow-md shadow-emerald-500/25 hover:brightness-110 disabled:opacity-50'
const DANGER = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50'
