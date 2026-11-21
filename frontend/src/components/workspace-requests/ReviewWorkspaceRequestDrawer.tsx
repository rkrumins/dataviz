/**
 * Reviewing a workspace request (platform and org admins): everything the requester
 * told us — what it's for, who's in it, what comes over from the Playground, what
 * data they need — and the three answers. Approve says exactly what will happen
 * before it happens, and lets the name and description be tidied first; Send back
 * asks the requester a question; Decline says why.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
    ArrowRight, Check, Clock, Database, FlaskConical, KeyRound, Link2, Loader2, MessageCircleQuestion, Rocket, Shield, User, Users,
    UsersRound, X, XCircle,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { groupFullName, nameTakenSuggestion, type WorkspaceRequest } from '@/services/workspaceRequestsService'
import { ssoAdminService } from '@/services/ssoAdminService'
import { useAuthStore } from '@/store/auth'
import { useFeature } from '@/store/features'
import { DATA_REQUESTS_FEATURE } from '@/hooks/useDataRequests'
import { useWorkspaceRequest, useWorkspaceRequestActions } from '@/hooks/useWorkspaceRequests'
import { PURPOSES, groupRoleLabel, purposeLabel } from './RequestSteps'

type Mode = 'read' | 'approve' | 'send-back' | 'decline'
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function ReviewWorkspaceRequestDrawer({ request: listed, onClose }: { request: WorkspaceRequest; onClose: () => void }) {
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const ref = useModalA11y(true, onClose)
    const actions = useWorkspaceRequestActions()
    // The full request (teammates and Playground graphs by name), falling back to the row's copy.
    const request = useWorkspaceRequest(listed.id).data ?? listed
    const [mode, setMode] = useState<Mode>('read')
    const [name, setName] = useState(request.name)
    const [description, setDescription] = useState(request.description ?? '')
    const [text, setText] = useState('')
    const [nameError, setNameError] = useState<{ suggestion: string | null } | null>(null)
    const [approved, setApproved] = useState<WorkspaceRequest | null>(null)

    const purpose = PURPOSES.find(p => p.value === request.purpose) ?? PURPOSES[0]
    const sources = request.playgroundSources ?? request.playgroundSourceIds.map(id => ({ id, label: id, viewCount: 0 }))
    const views = sources.reduce((n, s) => n + (s.viewCount ?? 0), 0)
    const teammates = request.teammates ?? request.teammateIds.map(id => ({ id, displayName: id }))
    const requester = request.requesterName || 'The requester'
    const open = request.status === 'pending'
    const busy = actions.approve.isPending || actions.sendBack.isPending || actions.decline.isPending

    // Proposed groups: their full names follow the workspace's unless the approver changed one.
    const groups = request.groups ?? []
    const [groupNames, setGroupNames] = useState<Record<string, string>>({})
    const fullName = (key: string, short: string) => groupNames[key] ?? groupFullName(name.trim() || request.name, short)
    const toLink = groups.filter(g => g.idpGroup?.trim())
    // Linking a group to the identity provider is a platform administrator's (the SSO rules' own bar).
    const canLink = useAuthStore(s => s.can('system:admin'))
    const dataRequestsOn = useFeature(DATA_REQUESTS_FEATURE)
    const providers = useQuery({
        queryKey: ['sso', 'providers'],
        queryFn: () => ssoAdminService.listProviders(),
        enabled: canLink && toLink.length > 0 && mode === 'approve',
        staleTime: 60_000,
    }).data ?? []
    const [providerId, setProviderId] = useState('')
    // The sandbox connection names its workspaces: graphs can't move into a new one unless it's let in.
    const sandboxClosed = request.sandboxAdmitsNew === false && sources.length > 0
    const [admit, setAdmit] = useState(true)

    const approve = () => actions.approve.mutate(
        {
            id: request.id, name: name.trim(), description: description.trim(),
            groupNames: Object.keys(groupNames).length ? groupNames : undefined,
            idpProviderId: canLink && toLink.length ? providerId || null : undefined,
            admitToSandbox: sandboxClosed && canLink ? admit : undefined,
        },
        {
            onSuccess: (r) => setApproved(r),
            onError: (e) => {
                const suggestion = nameTakenSuggestion(e)
                if (suggestion !== null || (e as { detail?: { type?: string } })?.detail?.type === 'name_taken') {
                    setNameError({ suggestion })
                    return
                }
                notify('error', e instanceof Error ? e.message : 'Couldn’t approve it.')
            },
        },
    )
    const answer = (kind: 'send-back' | 'decline') => {
        const done = { onSuccess: () => { notify('success', kind === 'send-back' ? `Sent back to ${requester}.` : 'Declined.'); onClose() },
            onError: (e: unknown) => notify('error', e instanceof Error ? e.message : 'Couldn’t send your answer.') }
        if (kind === 'send-back') actions.sendBack.mutate({ id: request.id, question: text.trim() }, done)
        else actions.decline.mutate({ id: request.id, reason: text.trim() || undefined }, done)
    }

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ws-request-review-title" tabIndex={-1}
                className="fixed inset-y-0 right-0 z-[61] flex w-full max-w-xl flex-col border-l border-glass-border bg-canvas-elevated shadow-2xl outline-none">
                {/* Header */}
                <div className="relative overflow-hidden border-b border-glass-border p-5">
                    <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.10] via-transparent to-fuchsia-500/[0.06]" />
                    <div className="relative flex items-start gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25">
                            <purpose.icon className="h-5 w-5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Workspace request</p>
                            <h2 id="ws-request-review-title" className="font-display text-xl font-bold text-ink truncate">{request.name}</h2>
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-ink-muted">
                                <span>From {requester}</span><span aria-hidden>·</span>
                                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" aria-hidden /> {timeAgo(request.createdAt)}</span>
                                <span aria-hidden>·</span><span>{purposeLabel(request.purpose)}</span>
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 space-y-5 overflow-y-auto custom-scrollbar p-5">
                    {approved ? (
                        <Approved request={approved} onOpen={() => { onClose(); navigate(`/workspaces/${approved.workspaceId}`) }} />
                    ) : (
                        <>
                            {request.description && <p className="text-sm text-ink-secondary">{request.description}</p>}
                            {(request.requesterEmail || request.playgroundActivity) && (
                                <div className="grid grid-cols-2 gap-2.5">
                                    {request.playgroundActivity && (
                                        <div className="rounded-2xl border border-glass-border p-3">
                                            <p className="text-lg font-bold tabular-nums text-ink">
                                                {request.playgroundActivity.graphs} <span className="text-sm font-medium text-ink-muted">graphs</span>{' · '}
                                                {request.playgroundActivity.views} <span className="text-sm font-medium text-ink-muted">views</span>
                                            </p>
                                            <p className="text-[11px] text-ink-muted">Built in the Playground</p>
                                        </div>
                                    )}
                                    {request.requesterEmail && (
                                        <a href={`mailto:${request.requesterEmail}`} className="min-w-0 rounded-2xl border border-glass-border p-3 hover:border-violet-500/40">
                                            <p className="truncate text-sm font-semibold text-ink">{request.requesterEmail}</p>
                                            <p className="text-[11px] text-ink-muted">Ask them directly</p>
                                        </a>
                                    )}
                                </div>
                            )}
                            {request.status === 'changes_requested' && request.question && (
                                <Callout icon={MessageCircleQuestion} tone="amber" title="You asked">
                                    {request.question}<span className="block text-xs text-ink-muted mt-1">Waiting for {requester} to answer.</span>
                                </Callout>
                            )}
                            {request.note && <Callout icon={MessageCircleQuestion} tone="violet" title={`${requester} says`}>{request.note}</Callout>}

                            <Section icon={Users} title="People">
                                <ul className="space-y-1.5">
                                    <Person name={requester} role="Admin" icon={Shield} />
                                    {teammates.map(t => <Person key={t.id} name={t.displayName} role="Member" />)}
                                </ul>
                                {request.teamName && <p className="mt-2 text-xs text-ink-muted">Team: {request.teamName}</p>}
                            </Section>

                            {groups.length > 0 && (
                                <Section icon={UsersRound} title="Groups">
                                    <ul className="space-y-2">
                                        {groups.map(g => (
                                            <li key={g.key} className="rounded-xl border border-glass-border px-3 py-2.5">
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                    <span className="text-sm font-semibold text-ink">{fullName(g.key, g.name)}</span>
                                                    <span className="rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-secondary">{groupRoleLabel(g.role)}</span>
                                                    {g.idpGroup?.trim() && (
                                                        <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                                                            <Link2 className="h-3 w-3" aria-hidden /> {g.idpGroup}
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="mt-0.5 text-xs text-ink-muted">
                                                    {(g.members ?? []).length ? (g.members ?? []).map(m => m.displayName).join(', ')
                                                        : g.memberIds.length ? plural(g.memberIds.length, 'person', 'people') : 'Nobody invited yet'}
                                                </p>
                                            </li>
                                        ))}
                                    </ul>
                                </Section>
                            )}

                            <Section icon={FlaskConical} title="From the Playground">
                                {sources.length === 0 ? <p className="text-sm text-ink-muted">Nothing — it starts empty.</p> : (
                                    <>
                                        <ul className="space-y-1.5">
                                            {sources.map(s => (
                                                <li key={s.id} className="flex items-center justify-between gap-3 rounded-xl border border-glass-border px-3 py-2 text-sm">
                                                    <span className="truncate font-medium text-ink">{s.label}</span>
                                                    <span className="shrink-0 text-xs text-ink-muted">{plural(s.viewCount ?? 0, 'view')}</span>
                                                </li>
                                            ))}
                                        </ul>
                                        <p className="mt-2 text-xs text-ink-muted">
                                            On approval these move with their views. People in the Playground who aren’t in the new workspace stop seeing them.
                                        </p>
                                        {sandboxClosed && (
                                            <div role="note" className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-xs text-ink">
                                                <p className="font-semibold text-amber-800 dark:text-amber-200">The sandbox connection only lets in workspaces it names.</p>
                                                {canLink ? (
                                                    <label className="mt-2 flex items-start gap-2">
                                                        <input type="checkbox" checked={admit} onChange={e => setAdmit(e.target.checked)} className="mt-0.5" />
                                                        <span>Let the new workspace in, so these graphs can move. Otherwise they stay in the Playground.</span>
                                                    </label>
                                                ) : (
                                                    <p className="mt-1 text-ink-secondary">
                                                        These graphs can’t move into a new workspace until a platform administrator lets it in. If you approve, they stay in the Playground for now.
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </>
                                )}
                            </Section>

                            <Section icon={Database} title="Data to connect">
                                <p className="text-sm text-ink">{request.dataNeeds || <span className="text-ink-muted">None named.</span>}</p>
                            </Section>

                            {mode === 'approve' && (
                                <div className="space-y-3 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] p-4">
                                    <label className="block">
                                        <span className="text-xs font-semibold text-ink-secondary">Name</span>
                                        <input value={name} onChange={e => { setName(e.target.value); setNameError(null) }} maxLength={120}
                                            aria-invalid={!!nameError} className={cn('input mt-1 w-full', nameError && 'border-rose-400')} />
                                    </label>
                                    {nameError && (
                                        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-rose-600 dark:text-rose-400">
                                            A workspace already has that name.
                                            {nameError.suggestion && (
                                                <button type="button" onClick={() => { setName(nameError.suggestion!); setNameError(null) }}
                                                    className="rounded-full bg-violet-500/10 px-2.5 py-1 font-semibold text-violet-700 dark:text-violet-300">
                                                    Use “{nameError.suggestion}”
                                                </button>
                                            )}
                                        </p>
                                    )}
                                    <label className="block">
                                        <span className="text-xs font-semibold text-ink-secondary">Description</span>
                                        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} maxLength={2000} className="input mt-1 w-full resize-none" />
                                    </label>
                                    {groups.length > 0 && (
                                        <fieldset className="space-y-2">
                                            <legend className="text-xs font-semibold text-ink-secondary">Group names</legend>
                                            {groups.map(g => (
                                                <input key={g.key} aria-label={`Name for ${g.name}`} value={fullName(g.key, g.name)} maxLength={200}
                                                    onChange={e => setGroupNames(n => ({ ...n, [g.key]: e.target.value }))}
                                                    className="input w-full text-sm" />
                                            ))}
                                        </fieldset>
                                    )}
                                    {toLink.length > 0 && (canLink ? (
                                        <label className="block">
                                            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                                                <KeyRound className="h-3.5 w-3.5 text-violet-500" aria-hidden /> Identity-provider connection for the links
                                            </span>
                                            <select aria-label="Identity-provider connection" value={providerId} onChange={e => setProviderId(e.target.value)} className="input mt-1 w-full text-sm">
                                                <option value="">Any connection</option>
                                                {providers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                                            </select>
                                        </label>
                                    ) : (
                                        <p className="rounded-xl bg-violet-500/[0.06] px-3 py-2 text-xs text-ink-secondary">
                                            Linking groups to the identity provider is a platform administrator’s: {plural(toLink.length, 'link')} will wait for one to confirm.
                                        </p>
                                    ))}
                                    <div>
                                        <p className="mb-1.5 text-xs font-semibold text-ink-secondary">Approving will</p>
                                        <ul className="space-y-1 text-sm text-ink">
                                            <Will>Create “{name.trim() || request.name}”</Will>
                                            <Will>Make {requester} its admin</Will>
                                            {teammates.length > 0 && <Will>Add {plural(teammates.length, 'teammate')} as {teammates.length === 1 ? 'a member' : 'members'}</Will>}
                                            {groups.length > 0 && (
                                                <Will>Create {plural(groups.length, 'group')} with {plural(groups.reduce((n, g) => n + g.memberIds.length, 0), 'person', 'people')} invited</Will>
                                            )}
                                            {toLink.length > 0 && (canLink
                                                ? <Will>Link {plural(toLink.length, 'group')} to the identity provider</Will>
                                                : <Will>Keep {plural(toLink.length, 'identity-provider link')} for a platform administrator</Will>)}
                                            {sources.length > 0 && <Will>Move {plural(sources.length, 'graph')} ({plural(views, 'view')}) from the Playground</Will>}
                                            {dataRequestsOn && request.dataNeeds?.trim() && <Will>Ask for the data it needs, tracked as a data request in the workspace</Will>}
                                        </ul>
                                    </div>
                                </div>
                            )}
                            {(mode === 'send-back' || mode === 'decline') && (
                                <label className="block rounded-2xl border border-glass-border p-4">
                                    <span className="text-xs font-semibold text-ink-secondary">
                                        {mode === 'send-back' ? `Your question for ${requester}` : 'Why (optional, shown to them)'}
                                    </span>
                                    <textarea value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={2000} autoFocus
                                        placeholder={mode === 'send-back' ? 'e.g. Which team will own it once the project ends?' : 'e.g. The Finance Data workspace already covers this — ask to join it.'}
                                        className="input mt-1 w-full resize-none" />
                                </label>
                            )}
                        </>
                    )}
                </div>

                {/* Footer */}
                {!approved && open && (
                    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-glass-border p-4">
                        {mode === 'read' ? (
                            <>
                                <button type="button" onClick={() => setMode('decline')} className={GHOST}><XCircle className="h-4 w-4" aria-hidden /> Decline</button>
                                <button type="button" onClick={() => setMode('send-back')} className={GHOST}><MessageCircleQuestion className="h-4 w-4" aria-hidden /> Send back</button>
                                <button type="button" onClick={() => setMode('approve')} className={APPROVE}><Check className="h-4 w-4" aria-hidden /> Approve…</button>
                            </>
                        ) : (
                            <>
                                <button type="button" onClick={() => { setMode('read'); setText('') }} disabled={busy} className={GHOST}>Back</button>
                                {mode === 'approve' && (
                                    <button type="button" onClick={approve} disabled={busy || !name.trim()} className={APPROVE}>
                                        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Rocket className="h-4 w-4" aria-hidden />} Approve and create
                                    </button>
                                )}
                                {mode === 'send-back' && (
                                    <button type="button" onClick={() => answer('send-back')} disabled={busy || !text.trim()} className={PRIMARY}>
                                        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Send back
                                    </button>
                                )}
                                {mode === 'decline' && (
                                    <button type="button" onClick={() => answer('decline')} disabled={busy} className={DANGER}>
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

function Approved({ request, onOpen }: { request: WorkspaceRequest; onOpen: () => void }) {
    const o = request.outcome
    return (
        <div className="flex flex-col items-center py-6 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg shadow-emerald-500/25">
                <Check className="h-7 w-7" aria-hidden />
            </span>
            <h3 className="font-display text-xl font-bold text-ink">“{request.name}” is ready</h3>
            <ul className="mt-3 space-y-1 text-sm text-ink-secondary">
                <li>Its admin has been told.</li>
                {!!o?.membersAdded.length && <li>{plural(o.membersAdded.length, 'teammate')} added.</li>}
                {!!o?.movedSources.length && <li>{plural(o.movedSources.length, 'graph')} moved from the Playground.</li>}
                {!!o?.groupsCreated?.length && <li>{plural(o.groupsCreated.length, 'group')} created: {o.groupsCreated.map(g => g.name).join(', ')}.</li>}
                {!!o?.idpLinksCreated?.length && <li>{plural(o.idpLinksCreated.length, 'group')} linked to the identity provider.</li>}
                {!!o?.idpLinksPending?.length && (
                    <li className="text-violet-700 dark:text-violet-300">{plural(o.idpLinksPending.length, 'identity-provider link')} waiting for a platform administrator.</li>
                )}
                {!!o?.idpLinksDeclined?.length && <li>{plural(o.idpLinksDeclined.length, 'identity-provider link')} declined.</li>}
                {!!o?.dataRequestIds?.length && <li>The data it needs was asked for — it’s tracked on the workspace’s Data → Sources.</li>}
                {!!o?.failedSources.length && (
                    <li className="text-amber-700 dark:text-amber-300">
                        {plural(o.failedSources.length, 'graph')} couldn’t be moved: {o.failedSources.map(f => f.reason).join('; ')}
                    </li>
                )}
            </ul>
            {request.workspaceId && (
                <button type="button" onClick={onOpen} className={cn(PRIMARY, 'mt-5')}>Open the workspace <ArrowRight className="h-4 w-4" aria-hidden /></button>
            )}
        </div>
    )
}

function Section({ icon: Icon, title, children }: { icon: typeof Users; title: string; children: React.ReactNode }) {
    return (
        <section>
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
            </h3>
            {children}
        </section>
    )
}

function Person({ name, role, icon: Icon = User }: { name: string; role: string; icon?: typeof User }) {
    return (
        <li className="flex items-center gap-2.5 text-sm">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-300"><Icon className="h-3.5 w-3.5" aria-hidden /></span>
            <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
            <span className="text-xs text-ink-muted">{role}</span>
        </li>
    )
}

function Callout({ icon: Icon, tone, title, children }: { icon: typeof Users; tone: 'amber' | 'violet'; title: string; children: React.ReactNode }) {
    return (
        <div className={cn('flex items-start gap-2.5 rounded-2xl border p-3',
            tone === 'amber' ? 'border-amber-500/25 bg-amber-500/[0.06]' : 'border-violet-500/20 bg-violet-500/[0.05]')}>
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : 'text-violet-500')} aria-hidden />
            <div className="min-w-0 text-sm text-ink"><span className="block text-xs font-semibold text-ink-secondary">{title}</span>{children}</div>
        </div>
    )
}

function Will({ children }: { children: React.ReactNode }) {
    return <li className="flex items-start gap-2"><Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden /><span>{children}</span></li>
}

const GHOST = 'inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06] disabled:opacity-50'
const PRIMARY = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-md shadow-violet-500/25 hover:brightness-110 disabled:opacity-50'
const APPROVE = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-gradient-to-r from-emerald-500 to-teal-500 shadow-md shadow-emerald-500/25 hover:brightness-110 disabled:opacity-50'
const DANGER = 'inline-flex h-9 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-500 disabled:opacity-50'
