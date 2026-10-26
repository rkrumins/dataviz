/**
 * Answer an access request — the decisions an approver can make, laid out
 * for the workspace's way of letting people in.
 *
 * Decided here (``accessMode: 'app'``):
 *   - **Grant a role** — what they asked for, or another level within what
 *     the approver may grant, for good or for 7, 30 or 90 days;
 *   - **Add to a team** — a team bound here whose every role the approver
 *     could grant, so the person gets what their colleagues have.
 *
 * Decided by the identity provider (``accessMode: 'idp'``):
 *   - **Point to a group** — the IdP group that grants it; the request waits
 *     and closes itself when the access arrives at their next sign-in;
 *   - **Grant an exception** — access here that doesn't follow their groups,
 *     said out loud, for 30 days unless the approver chooses otherwise.
 *
 * A request to keep access that is about to end is answered with how much
 * longer — 30 days unless the approver chooses otherwise.
 *
 * Exceptions are the workspace admins' alone, and always end — within 90
 * days — including when someone asks to keep one. Whatever is granted, the
 * dialog says which data sources it opens: every role reads all of them.
 *
 * Every choice comes from the server's grant options, so nothing offered
 * here is refused for being more than the approver could grant.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, Check, KeyRound, Loader2, ShieldCheck, UserPlus, Users2, X } from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { Segmented } from '@/components/ui/Segmented'
import { useAppNotifications } from '@/components/ui/notifications'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAnswerActions, useGrantOptions } from '@/hooks/useWorkspaceAccess'
import type { AccessRequestResponse } from '@/services/accessRequestsService'
import { cn } from '@/lib/utils'
import { roleLabel } from './accessRequestCopy'
import { ServiceAccountFacts } from './ServiceAccountFacts'
import { WorkspaceReachNote } from './WorkspaceReachNote'

type Decision = 'role' | 'team' | 'route' | 'exception'

const DURATIONS = [
    { value: '', label: 'No end date' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: '90d', label: '90 days' },
] as const
/** An exception always ends. */
const ENDING = DURATIONS.filter(d => d.value !== '')

export function ApproveRequestDialog({ request, onClose }: {
    request: AccessRequestResponse
    onClose: () => void
}) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const { options, isLoading, error } = useGrantOptions(request.target.id)
    const { approve, route } = useAnswerActions()
    const idp = (options?.accessMode ?? request.target.accessMode) === 'idp'
    const who = request.requester.displayName ?? request.requester.email ?? request.requester.id
    const where = request.target.label ?? 'this workspace'
    // Asking to keep a grant: the only decision is how much longer.
    const extension = !!request.bindingId
    const steward = options?.tier === 'steward'
    // Keeping an exception going is the admins' call, and it keeps an end.
    const keepsException = extension && !!request.idpException
    // A service account gets a role — never a team, the identity provider's
    // group or an exception, since the provider doesn't know it. Where the
    // provider decides who is in, only the workspace's admins give it one.
    const account = !!request.serviceAccount
    const accountRefused = account && idp && steward

    const [decision, setDecision] = useState<Decision | null>(null)
    const chosen: Decision = decision ?? (idp && !account ? 'route' : 'role')
    const roles = useMemo(
        () => (options?.roles ?? []).filter(r => !account || r.requestable !== false),
        [options, account],
    )
    const [role, setRole] = useState<string | null>(null)
    const pickedRole = role
        ?? (roles.some(r => r.name === request.requestedRole) ? request.requestedRole : roles[0]?.name ?? null)
    const [duration, setDuration] = useState<string | null>(null)
    const exceptional = chosen === 'exception' || keepsException
    const pickedDuration = exceptional && duration === ''
        ? '30d'
        : duration ?? (exceptional || extension ? '30d' : '')
    const [groupId, setGroupId] = useState<string | null>(null)
    const routes = useMemo(() => {
        const seen = new Map<string, NonNullable<typeof options>['idpRoutes']>()
        for (const r of options?.idpRoutes ?? []) seen.set(r.idpGroup, [...(seen.get(r.idpGroup) ?? []), r])
        return [...seen.entries()]
    }, [options])
    const [idpGroup, setIdpGroup] = useState<string | null>(null)
    const pickedGroup = idpGroup ?? routes[0]?.[0] ?? null
    const [note, setNote] = useState('')

    const pending = approve.isPending || route.isPending
    const ready = accountRefused
        ? false
        : extension
            ? !(keepsException && steward)
            : chosen === 'team' ? !!groupId : chosen === 'route' ? !!pickedGroup : !!pickedRole

    const submit = async () => {
        const trimmed = note.trim() || null
        try {
            if (extension) {
                await approve.mutateAsync({
                    id: request.id,
                    body: { expiresIn: pickedDuration || null, note: trimmed, exception: keepsException || undefined },
                })
                const label = DURATIONS.find(d => d.value === pickedDuration)?.label.toLowerCase()
                notify('success', `${who} keeps their access to ${where}${pickedDuration ? ` for ${label}` : ' with no end date'}.`)
            } else if (chosen === 'route' && pickedGroup) {
                await route.mutateAsync({ id: request.id, body: { idpGroup: pickedGroup, note: trimmed } })
                notify('success', `Pointed ${who} to “${pickedGroup}”. The request closes itself when the access arrives.`)
            } else if (chosen === 'team' && groupId) {
                await approve.mutateAsync({ id: request.id, body: { groupId, note: trimmed } })
                notify('success', `Added ${who} to the team.`)
            } else if (pickedRole) {
                await approve.mutateAsync({
                    id: request.id,
                    body: {
                        role: pickedRole,
                        expiresIn: pickedDuration || null,
                        exception: chosen === 'exception',
                        note: trimmed,
                    },
                })
                notify('success', `${who} can now open ${where} as ${roleLabel(pickedRole)}.`)
            }
            onClose()
        } catch (err) {
            notify('error', (err as Error).message)
        }
    }

    const choices = account
        ? []
        : idp
        ? [
            { value: 'route' as const, label: 'Point to a group', icon: KeyRound },
            ...(steward ? [] : [{ value: 'exception' as const, label: 'Grant an exception', icon: AlertTriangle }]),
        ]
        : [
            { value: 'role' as const, label: 'Grant a role', icon: ShieldCheck },
            ...((options?.groups.length ?? 0) > 0 ? [{ value: 'team' as const, label: 'Add to a team', icon: Users2 }] : []),
        ]

    return (
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Answer ${who}’s request`}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-xl max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none animate-in fade-in zoom-in-95 duration-200"
                >
                    <div className={cn('h-1 rounded-t-2xl bg-gradient-to-r', idp ? 'from-sky-500 via-indigo-500 to-violet-500' : 'from-emerald-500 via-teal-500 to-sky-500')} />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                            <UserPlus className="w-5 h-5" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">
                                {extension ? `Let ${who} keep their access to ${where}?` : `Let ${who} into ${where}?`}
                            </h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                {extension ? 'Their' : 'Asked for'} <span className="font-semibold text-ink">{roleLabel(request.requestedRole)}</span>
                                {extension && (request.currentExpiresAt
                                    ? ` access ends on ${new Date(request.currentExpiresAt).toLocaleDateString()}`
                                    : ' access')}
                                {idp && ' · its identity provider decides who is in'}
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>

                    <div className="px-6 pb-2 space-y-4">
                        {request.justification && (
                            <blockquote className="rounded-xl border-l-2 border-emerald-500/50 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2 text-sm text-ink-secondary">
                                “{request.justification}”
                            </blockquote>
                        )}
                        <ServiceAccountFacts request={request} />

                        {accountRefused ? (
                            <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                Its identity provider decides who is in {where}, so only the workspace’s admins give a
                                service account access here.
                            </p>
                        ) : extension && keepsException && steward ? (
                            <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                This access is an exception to the identity provider. Only the workspace’s admins can keep
                                an exception going — or point {who} to the group that grants it.
                            </p>
                        ) : extension ? (
                            <>
                                {keepsException && (
                                    <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                                        <AlertTriangle className="w-4 h-4 shrink-0" />
                                        This access is an exception to the identity provider. Keeping it keeps it as one —
                                        for 90 days at most.
                                    </p>
                                )}
                                <div>
                                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                                        <CalendarClock className="w-3.5 h-3.5" aria-hidden /> For how much longer
                                    </p>
                                    <Segmented
                                        label="For how much longer"
                                        value={pickedDuration as (typeof DURATIONS)[number]['value']}
                                        onChange={setDuration}
                                        options={keepsException ? ENDING : DURATIONS}
                                    />
                                    <p className="text-xs text-ink-muted mt-2">From today. They hear before it ends again.</p>
                                </div>
                                <label className="block">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">A note for {who} (optional)</span>
                                    <textarea
                                        value={note}
                                        maxLength={1000}
                                        rows={2}
                                        onChange={e => setNote(e.target.value)}
                                        className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none text-sm"
                                    />
                                </label>
                            </>
                        ) : isLoading ? (
                            <div className="h-40 rounded-xl bg-black/5 dark:bg-white/5 animate-pulse" />
                        ) : error ? (
                            <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">{error.message}</p>
                        ) : (
                            <>
                                {choices.length > 1 && (
                                    <Segmented label="Answer" value={chosen} onChange={setDecision} options={choices} size="md" />
                                )}

                                {chosen === 'route' && (
                                    routes.length === 0 ? (
                                        <p className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-sm text-ink-secondary">
                                            No identity-provider group you could point them to reaches this workspace yet.
                                            {steward
                                                ? ' Ask whoever runs sign-in to map one; only the workspace’s admins can grant an exception.'
                                                : ' Ask whoever runs sign-in to map one, or grant an exception.'}
                                        </p>
                                    ) : (
                                        <fieldset className="space-y-2">
                                            <legend className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">The group that grants it</legend>
                                            {routes.map(([group, via]) => (
                                                <OptionCard
                                                    key={group}
                                                    selected={pickedGroup === group}
                                                    onSelect={() => setIdpGroup(group)}
                                                    title={group}
                                                    detail={via.map(v => `${roleLabel(v.role ?? '')}${v.viaGroupName ? ` through ${v.viaGroupName}` : ''}`).join(', ')
                                                        + (via[0].provider ? ` · ${via[0].provider}` : '')}
                                                />
                                            ))}
                                            {request.requester.ssoLinked === false && (
                                                <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                                                    <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
                                                    {who} has never signed in through your identity provider — their access arrives only once they do.
                                                </p>
                                            )}
                                        </fieldset>
                                    )
                                )}

                                {chosen === 'exception' && (
                                    <p className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                                        <AlertTriangle className="w-4 h-4 shrink-0" />
                                        <span>
                                            Granted here, outside your identity provider: it won’t follow {who}’s groups,
                                            and lasts 90 days at most, unless someone removes it first. People with access marks it
                                            as an exception.
                                        </span>
                                    </p>
                                )}

                                {(chosen === 'role' || chosen === 'exception') && (
                                    <>
                                        <fieldset className="space-y-2">
                                            <legend className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                                                {options?.tier === 'steward' ? 'Level (stewards grant Viewer or Member)' : 'Level'}
                                            </legend>
                                            {roles.map(r => (
                                                <OptionCard
                                                    key={r.name}
                                                    selected={pickedRole === r.name}
                                                    onSelect={() => setRole(r.name)}
                                                    title={roleLabel(r.name)}
                                                    detail={r.name === request.requestedRole ? 'What they asked for' : (r.description ?? '')}
                                                />
                                            ))}
                                        </fieldset>
                                        <div>
                                            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">For how long</p>
                                            <Segmented
                                                label="For how long"
                                                value={pickedDuration as (typeof DURATIONS)[number]['value']}
                                                onChange={setDuration}
                                                options={chosen === 'exception' ? ENDING : DURATIONS}
                                            />
                                        </div>
                                    </>
                                )}

                                {chosen === 'team' && (
                                    <fieldset className="space-y-2">
                                        <legend className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">Team</legend>
                                        {options?.groups.map(g => (
                                            <OptionCard
                                                key={g.id}
                                                selected={groupId === g.id}
                                                onSelect={() => setGroupId(g.id)}
                                                title={g.name}
                                                detail={`${g.memberCount} ${g.memberCount === 1 ? 'member' : 'members'} · ${g.roles.map(roleLabel).join(', ')} here`}
                                            />
                                        ))}
                                    </fieldset>
                                )}

                                {chosen !== 'route' && <WorkspaceReachNote sources={options?.dataSources} />}

                                <label className="block">
                                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">A note for {who} (optional)</span>
                                    <textarea
                                        value={note}
                                        maxLength={1000}
                                        rows={2}
                                        onChange={e => setNote(e.target.value)}
                                        placeholder={chosen === 'route' ? 'Raise a ticket with the service desk' : 'Welcome aboard'}
                                        className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none text-sm"
                                    />
                                </label>
                            </>
                        )}
                    </div>

                    <footer className="flex items-center justify-end gap-3 px-6 py-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={!ready || pending || (!extension && (isLoading || !!error))}
                            onClick={() => void submit()}
                            className={cn(
                                'inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white shadow-md disabled:opacity-50',
                                exceptional
                                    ? 'bg-gradient-to-r from-amber-500 to-orange-600'
                                    : 'bg-gradient-to-r from-emerald-500 to-teal-600',
                            )}
                        >
                            {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            {extension
                                ? 'Let them keep it'
                                : { role: 'Approve', team: 'Add to team', route: 'Point to group', exception: 'Grant exception' }[chosen]}
                        </button>
                    </footer>
                </div>
            </div>
        </>
    )
}

function OptionCard({ selected, onSelect, title, detail }: {
    selected: boolean
    onSelect: () => void
    title: string
    detail?: string
}) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={onSelect}
            className={cn(
                'w-full flex items-start gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors',
                selected
                    ? 'border-emerald-500/50 bg-emerald-500/[0.06] ring-1 ring-emerald-500/30'
                    : 'border-glass-border hover:border-emerald-500/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]',
            )}
        >
            <span className={cn(
                'mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0',
                selected ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-slate-300 dark:border-slate-600',
            )}>
                {selected && <Check className="w-2.5 h-2.5" strokeWidth={3} />}
            </span>
            <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink truncate">{title}</span>
                {detail && <span className="block text-xs text-ink-muted mt-0.5">{detail}</span>}
            </span>
        </button>
    )
}
