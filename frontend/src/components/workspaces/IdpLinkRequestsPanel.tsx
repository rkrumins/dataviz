/**
 * Links to identity-provider groups waiting for a platform administrator, on
 * Workspaces → Requests: a workspace admin asked to link one of their groups, or an
 * Org Admin approved a workspace request whose groups named one. Each row says which
 * group, in which workspace, the directory group it would follow and how many people
 * have it — then Link (from any connection, or one) or Decline. Renders nothing for
 * anyone else, or when nothing waits.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, Link2, Loader2, Users, X } from 'lucide-react'
import { timeAgo } from '@/lib/timeAgo'
import { ssoAdminService } from '@/services/ssoAdminService'
import { useAppNotifications } from '@/components/ui/notifications'
import { useIdpLinkRequestActions, useIdpLinkRequests } from '@/hooks/useWorkspaceGroups'
import type { IdpLinkRequest } from '@/services/workspaceGroupsService'

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

export function IdpLinkRequestsPanel() {
    const waiting = useIdpLinkRequests('pending').data ?? []
    const providers = useQuery({
        queryKey: ['sso', 'providers'], queryFn: () => ssoAdminService.listProviders(),
        enabled: waiting.length > 0, staleTime: 60_000,
    }).data ?? []
    if (waiting.length === 0) return null

    return (
        <section aria-labelledby="idp-links-title" className="overflow-hidden rounded-2xl border border-violet-500/25 bg-canvas-elevated">
            <div className="flex items-start gap-2 border-b border-glass-border px-4 sm:px-5 py-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-300">
                    <KeyRound className="h-3.5 w-3.5" aria-hidden />
                </span>
                <div className="min-w-0">
                    <h2 id="idp-links-title" className="flex items-center gap-2 text-sm font-bold text-ink">
                        Identity-provider links to confirm
                        <span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-semibold text-violet-700 dark:text-violet-300">{waiting.length}</span>
                    </h2>
                    <p className="text-[11px] text-ink-muted">Workspace groups that should follow a directory group. Once linked, people in it join at their next sign-in.</p>
                </div>
            </div>
            <ul className="divide-y divide-glass-border">
                {waiting.map(r => <LinkRow key={r.id} request={r} providers={providers} />)}
            </ul>
        </section>
    )
}

function LinkRow({ request: r, providers }: { request: IdpLinkRequest; providers: { id: string; displayName: string }[] }) {
    const { notify } = useAppNotifications()
    const { link, decline } = useIdpLinkRequestActions()
    const [provider, setProvider] = useState(r.providerId ?? '')
    const [declining, setDeclining] = useState(false)
    const [reason, setReason] = useState('')
    const group = r.groupName || r.groupId
    const busy = link.isPending || decline.isPending

    return (
        <li className="px-4 sm:px-5 py-3">
            <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">{group}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-muted">
                        <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 font-semibold text-violet-700 dark:text-violet-300">
                            <Link2 className="h-3 w-3 shrink-0" aria-hidden /> <span className="truncate">{r.idpGroup}</span>
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <Users className="h-3 w-3 shrink-0" aria-hidden />
                            {r.seenCount > 0 ? `${r.seenCount} ${r.seenCount === 1 ? 'person has' : 'people have'} it` : 'Nobody has signed in with it yet'}
                        </span>
                        <span>
                            {r.source === 'workspace_request' ? 'From an approved workspace request' : `Asked by ${r.requestedByName || 'a workspace admin'}`}
                            {r.workspaceName ? ` · ${r.workspaceName}` : ''} · {timeAgo(r.requestedAt)}
                        </span>
                    </span>
                </span>
                {!declining && (
                    <span className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
                        <select aria-label={`Connection for ${group}`} value={provider} onChange={e => setProvider(e.target.value)}
                            className="h-8 min-w-0 flex-1 sm:w-40 sm:flex-none rounded-lg border border-black/[0.08] dark:border-white/[0.10] bg-canvas px-2 text-xs text-ink outline-none focus:border-indigo-500">
                            <option value="">Any connection</option>
                            {providers.map(p => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                        </select>
                        <button type="button" disabled={busy} onClick={() => setDeclining(true)}
                            className="h-8 rounded-lg border border-glass-border px-3 text-xs font-semibold text-ink-secondary hover:border-rose-500/40 hover:text-rose-600 disabled:opacity-50">
                            Decline
                        </button>
                        <button type="button" disabled={busy}
                            onClick={() => link.mutate({ id: r.id, providerId: provider || null }, {
                                onSuccess: () => notify('success', `${group} now follows ${r.idpGroup}.`),
                                onError: e => notify('error', message(e, 'Couldn’t link it.')),
                            })}
                            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">
                            {link.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />} Link
                        </button>
                    </span>
                )}
            </div>
            {declining && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input aria-label={`Why not link ${group}`} value={reason} maxLength={2000} autoFocus onChange={e => setReason(e.target.value)}
                        placeholder="Tell them why (optional) — they’ll see it in their inbox"
                        className="h-8 min-w-[16rem] flex-1 rounded-lg border border-black/[0.08] dark:border-white/[0.10] bg-canvas px-2.5 text-xs text-ink outline-none focus:border-indigo-500" />
                    <button type="button" onClick={() => setDeclining(false)} aria-label="Keep it waiting"
                        className="rounded-lg p-1.5 text-ink-muted hover:text-ink"><X className="h-4 w-4" /></button>
                    <button type="button" disabled={busy}
                        onClick={() => decline.mutate({ id: r.id, reason: reason.trim() || undefined }, {
                            onSuccess: () => notify('success', `Declined — ${group} stays as it is.`),
                            onError: e => notify('error', message(e, 'Couldn’t decline it.')),
                        })}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-600 px-3 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
                        {decline.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />} Decline link
                    </button>
                </div>
            )}
        </li>
    )
}
