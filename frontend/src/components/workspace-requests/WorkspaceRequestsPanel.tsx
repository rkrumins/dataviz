/**
 * Workspace requests waiting on the platform team (platform and org admins), on
 * Workspaces → Requests: who asked for what, how long they've waited, what comes
 * with it — and Review, which opens the request to approve, send back or decline.
 * Renders nothing while requests are off, for anyone who can't answer them, or when
 * nothing waits and `hideWhenEmpty` is set.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Building2, Clock, FlaskConical, KeyRound, Link2, Loader2, MessageCircleQuestion, Users, UsersRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useFeature } from '@/store/features'
import { useAuthStore } from '@/store/auth'
import { ssoAdminService } from '@/services/ssoAdminService'
import { useAppNotifications } from '@/components/ui/notifications'
import type { WorkspaceRequest } from '@/services/workspaceRequestsService'
import { Segmented } from '@/components/ui/Segmented'
import {
    WORKSPACE_REQUESTS_FEATURE, useCanAnswerWorkspaceRequests, useWorkspaceRequestActions, useWorkspaceRequestsToAnswer,
} from '@/hooks/useWorkspaceRequests'
import { ReviewWorkspaceRequestDrawer } from './ReviewWorkspaceRequestDrawer'
import { PURPOSES } from './RequestSteps'

const days = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function WorkspaceRequestsPanel({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
    const on = useFeature(WORKSPACE_REQUESTS_FEATURE)
    const can = useCanAnswerWorkspaceRequests()
    const [filter, setFilter] = useState<'open' | 'all'>('open')
    const { data, isLoading } = useWorkspaceRequestsToAnswer(filter)
    const [reviewing, setReviewing] = useState<WorkspaceRequest | null>(null)
    if (!on || !can) return null
    const rows = data ?? []
    if (hideWhenEmpty && !isLoading && rows.length === 0 && filter === 'open') return <IdpLinksToConfirm />

    return (
        <>
        <section aria-labelledby="ws-requests-title" className="overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-glass-border px-5 py-3">
                <h2 id="ws-requests-title" className="flex items-center gap-2 text-sm font-bold text-ink">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
                        <Building2 className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    Requests for new workspaces
                    {filter === 'open' && rows.length > 0 && (
                        <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">{rows.length}</span>
                    )}
                </h2>
                <Segmented label="Show" value={filter} onChange={setFilter}
                    options={[{ value: 'open', label: 'Waiting' }, { value: 'all', label: 'All' }]} />
            </div>
            {isLoading ? (
                <p className="px-5 py-6 text-center text-sm text-ink-muted">Loading…</p>
            ) : rows.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-ink-muted">
                    {filter === 'open' ? 'Nobody is waiting for a workspace.' : 'No workspace requests yet.'}
                </p>
            ) : (
                <ul className="divide-y divide-glass-border">
                    {rows.map(r => {
                        const purpose = PURPOSES.find(p => p.value === r.purpose) ?? PURPOSES[0]
                        const waited = days(r.createdAt)
                        const asked = r.status === 'changes_requested'
                        return (
                            <li key={r.id} className="flex items-center gap-3 px-5 py-3.5">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
                                    <purpose.icon className="h-4 w-4" aria-hidden />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span className="truncate text-sm font-semibold text-ink">{r.name}</span>
                                        <span className="rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-ink-secondary">{purpose.label}</span>
                                        {asked && (
                                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                                                <MessageCircleQuestion className="h-3 w-3" aria-hidden /> Waiting on them
                                            </span>
                                        )}
                                        {r.status !== 'pending' && !asked && (
                                            <span className="rounded-full bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold capitalize text-ink-secondary">{r.status}</span>
                                        )}
                                    </span>
                                    <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11px] text-ink-muted">
                                        <span>From {r.requesterName || 'someone'} · {timeAgo(r.createdAt)}</span>
                                        {r.teammateIds.length > 0 && <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" aria-hidden />{plural(r.teammateIds.length, 'teammate')}</span>}
                                        {r.playgroundSourceIds.length > 0 && <span className="inline-flex items-center gap-1"><FlaskConical className="h-3 w-3" aria-hidden />{plural(r.playgroundSourceIds.length, 'graph')} from the Playground</span>}
                                        {!!r.groups?.length && <span className="inline-flex items-center gap-1"><UsersRound className="h-3 w-3" aria-hidden />{plural(r.groups.length, 'group')}{r.groups.some(g => g.idpGroup) ? ' · linked to the identity provider' : ''}</span>}
                                    </span>
                                </span>
                                {r.status === 'pending' && waited >= 1 && (
                                    <span className={cn('hidden sm:inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                                        waited >= 7 ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400' : waited >= 3 ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary')}>
                                        <Clock className="h-2.5 w-2.5" aria-hidden /> Waiting {plural(waited, 'day')}
                                    </span>
                                )}
                                <button type="button" onClick={() => setReviewing(r)}
                                    className="shrink-0 rounded-xl border border-glass-border px-3 py-1.5 text-xs font-semibold text-ink hover:border-violet-500/40 hover:bg-violet-500/[0.05]">
                                    Review
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}
            {reviewing && <ReviewWorkspaceRequestDrawer request={reviewing} onClose={() => setReviewing(null)} />}
        </section>
        <IdpLinksToConfirm />
        </>
    )
}

/** Groups made by approved requests whose identity-provider links wait for a platform
 *  administrator — an Org Admin approved them, and linking is the SSO rules' own bar. */
export function IdpLinksToConfirm() {
    const { notify } = useAppNotifications()
    const canLink = useAuthStore(s => s.can('system:admin'))
    const approved = useWorkspaceRequestsToAnswer('approved').data ?? []
    const waiting = canLink ? approved.flatMap(r => (r.outcome?.idpLinksPending ?? []).map(l => ({ ...l, request: r }))) : []
    const providers = useQuery({
        queryKey: ['sso', 'providers'], queryFn: () => ssoAdminService.listProviders(),
        enabled: waiting.length > 0, staleTime: 60_000,
    }).data ?? []
    const [chosen, setChosen] = useState<Record<string, string>>({})
    const { linkIdpGroup } = useWorkspaceRequestActions()
    if (waiting.length === 0) return null

    return (
        <section aria-labelledby="idp-links-title" className="overflow-hidden rounded-2xl border border-violet-500/25 bg-canvas-elevated">
            <div className="flex items-center gap-2 border-b border-glass-border px-5 py-3">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
                    <KeyRound className="h-3.5 w-3.5" aria-hidden />
                </span>
                <div>
                    <h2 id="idp-links-title" className="text-sm font-bold text-ink">Identity-provider links to confirm</h2>
                    <p className="text-[11px] text-ink-muted">Groups from approved workspace requests. Once linked, people in the directory group join them at sign-in.</p>
                </div>
            </div>
            <ul className="divide-y divide-glass-border">
                {waiting.map(l => (
                    <li key={l.groupId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-ink">{l.groupName}</span>
                            <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                                <Link2 className="h-3 w-3" aria-hidden /> {l.idpGroup}
                            </span>
                        </span>
                        <select aria-label={`Connection for ${l.groupName}`} value={chosen[l.groupId] ?? ''}
                            onChange={e => setChosen(c => ({ ...c, [l.groupId]: e.target.value }))} className="input h-8 text-xs">
                            <option value="">Any connection</option>
                            {providers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                        </select>
                        <button type="button" disabled={linkIdpGroup.isPending}
                            onClick={() => linkIdpGroup.mutate(
                                { id: l.request.id, groupId: l.groupId, idpProviderId: chosen[l.groupId] || null },
                                {
                                    onSuccess: () => notify('success', `${l.groupName} now follows ${l.idpGroup}.`),
                                    onError: e => notify('error', e instanceof Error ? e.message : 'Couldn’t link it.'),
                                },
                            )}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">
                            {linkIdpGroup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />} Link
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    )
}
