/**
 * One of a workspace's groups, opened from the People tab: what it can do here, who is
 * in it, and the identity-provider group it follows — each changed in place by the
 * workspace's admins when the workspace owns it. And the dialog that makes a new one.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Clock, KeyRound, Link2, Loader2, Trash2, Unlink, UsersRound, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useAppNotifications } from '@/components/ui/notifications'
import { useAuthStore } from '@/store/auth'
import { useGroupMembers, useWorkspaceGroupActions } from '@/hooks/useWorkspaceGroups'
import type { GroupRole, WorkspaceGroup } from '@/services/workspaceGroupsService'
import { groupFullName } from '@/services/workspaceRequestsService'
import { SubjectPicker, subjectKey } from '@/components/serviceAccounts/SubjectPicker'
import { GROUP_ROLES } from '@/components/workspace-requests/RequestSteps'
import { IdpGroupInput } from './IdpGroupInput'

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback)

function RolePicker({ value, onChange, disabled }: { value?: string | null; onChange: (r: GroupRole) => void; disabled?: boolean }) {
    return (
        <div role="radiogroup" aria-label="What the group can do" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {GROUP_ROLES.map(r => {
                const on = value === r.value
                return (
                    <button key={r.value} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(r.value)}
                        className={cn('rounded-xl border-2 px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed',
                            on ? 'border-violet-500 bg-violet-500/[0.06]' : 'border-black/[0.08] dark:border-white/[0.10]',
                            !on && !disabled && 'hover:border-violet-500/40', disabled && !on && 'opacity-60')}>
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink"><r.icon className="h-3.5 w-3.5 text-violet-500" aria-hidden />{r.label}</span>
                        <span className="mt-0.5 block text-[10px] leading-snug text-ink-muted">{r.detail}</span>
                    </button>
                )
            })}
        </div>
    )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section className="space-y-2.5">
            <div>
                <h3 className="text-xs font-bold uppercase tracking-wide text-ink-muted">{title}</h3>
                {hint && <p className="mt-0.5 text-xs text-ink-secondary">{hint}</p>}
            </div>
            {children}
        </section>
    )
}

// ── The drawer ──────────────────────────────────────────────────────────

export function WorkspaceGroupDrawer({ workspaceId, group: g, canManage, onClose, onChanged }: {
    workspaceId: string
    group: WorkspaceGroup
    canManage: boolean
    onClose: () => void
    onChanged?: () => void
}) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const isPlatformAdmin = useAuthStore(s => s.can('system:admin'))
    const editable = canManage && g.owned
    const actions = useWorkspaceGroupActions(workspaceId)
    const members = useGroupMembers(workspaceId, g.id)
    const [name, setName] = useState(g.shortName)
    const [description, setDescription] = useState(g.description ?? '')
    const [idpGroup, setIdpGroup] = useState('')
    const [confirmDelete, setConfirmDelete] = useState(false)
    const detailsChanged = name.trim() !== g.shortName || description.trim() !== (g.description ?? '')
    const after = (ok: string, then?: () => void) => ({
        onSuccess: () => { notify('success', ok); onChanged?.(); then?.() },
        onError: (e: unknown) => notify('error', message(e, 'That didn’t work.')),
    })

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ws-group-title" tabIndex={-1}
                className="fixed inset-y-0 right-0 z-[61] flex w-full max-w-lg flex-col border-l border-glass-border bg-canvas-elevated shadow-2xl outline-none">
                <div className="relative overflow-hidden border-b border-glass-border p-5">
                    <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.10] via-transparent to-fuchsia-500/[0.06]" />
                    <div className="relative flex items-start gap-3">
                        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25">
                            <UsersRound className="h-5 w-5" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{g.owned ? 'Group' : 'Platform group'}</p>
                            <h2 id="ws-group-title" className="truncate font-display text-xl font-bold text-ink">{g.shortName}</h2>
                            <p className="mt-0.5 truncate text-xs text-ink-muted">{g.name} · {g.memberCount} {g.memberCount === 1 ? 'person' : 'people'}</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-muted hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.06]">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 space-y-6 overflow-y-auto custom-scrollbar p-5">
                    {!g.owned && (
                        <p className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2.5 text-xs text-ink-secondary">
                            A platform-wide group, bound here. Its name, people and identity-provider links are managed on Admin → Groups; its access here, from the bindings above.
                        </p>
                    )}

                    <Section title="What they can do here">
                        {g.owned ? (
                            <RolePicker value={g.role} disabled={!editable || actions.update.isPending}
                                onChange={role => role !== g.role && actions.update.mutate({ groupId: g.id, role }, after('Its access here changed.'))} />
                        ) : (
                            <p className="text-sm text-ink">{g.roleLabel || g.role || 'No role here'}</p>
                        )}
                    </Section>

                    {editable && (
                        <Section title="Name and description">
                            <div>
                                <input aria-label="Group name" value={name} maxLength={80} onChange={e => setName(e.target.value)}
                                    className="w-full rounded-xl border-2 border-black/[0.10] dark:border-white/[0.12] bg-canvas px-3 py-2 text-sm font-semibold text-ink outline-none focus:border-indigo-500" />
                                {name.trim() && name.trim() !== g.shortName && (
                                    <p className="mt-1 text-[11px] text-ink-muted">Becomes “{groupFullName(g.name.slice(0, -` · ${g.shortName}`.length) || g.name, name)}”</p>
                                )}
                            </div>
                            <textarea aria-label="Description" value={description} maxLength={500} rows={2} onChange={e => setDescription(e.target.value)}
                                placeholder="Who it’s for — e.g. the analysts who build the monthly views"
                                className="w-full resize-none rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500" />
                            {detailsChanged && (
                                <div className="flex justify-end gap-2">
                                    <button type="button" onClick={() => { setName(g.shortName); setDescription(g.description ?? '') }}
                                        className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink">Undo</button>
                                    <button type="button" disabled={!name.trim() || actions.update.isPending}
                                        onClick={() => actions.update.mutate({ groupId: g.id, name: name.trim(), description: description.trim() }, after('Saved.'))}
                                        className="inline-flex items-center gap-1.5 rounded-lg bg-accent-lineage px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">
                                        {actions.update.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />} Save
                                    </button>
                                </div>
                            )}
                        </Section>
                    )}

                    <Section title="People" hint={g.idpLinks.length > 0 ? 'People the identity provider adds come and go with the directory group.' : undefined}>
                        {members.isLoading ? (
                            <p className="flex items-center gap-1.5 text-xs text-ink-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading…</p>
                        ) : (members.data ?? []).length === 0 ? (
                            <p className="text-sm text-ink-muted">Nobody yet{editable ? ' — invite someone below.' : '.'}</p>
                        ) : (
                            <ul aria-label={`People in ${g.shortName}`} className="divide-y divide-glass-border rounded-xl border border-glass-border">
                                {(members.data ?? []).map(m => (
                                    <li key={m.id} className="flex items-center gap-2.5 px-3 py-2">
                                        <UserAvatar userId={m.id} name={m.displayName || m.email || m.id} hasImage={false} className="h-7 w-7 text-[10px]" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-sm font-medium text-ink">{m.displayName || m.email || m.id}</span>
                                            {m.email && m.displayName && <span className="block truncate text-[11px] text-ink-muted">{m.email}</span>}
                                        </span>
                                        {m.source === 'sso' ? (
                                            <span title="The identity provider put them here, and takes them out" className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                                                <KeyRound className="h-2.5 w-2.5" aria-hidden /> From the directory
                                            </span>
                                        ) : editable && (
                                            <button type="button" aria-label={`Remove ${m.displayName || m.id}`} disabled={actions.removeMember.isPending}
                                                onClick={() => actions.removeMember.mutate({ groupId: g.id, userId: m.id }, after(`${m.displayName || 'They'} left ${g.shortName}.`))}
                                                className="rounded-lg p-1.5 text-ink-muted hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-50">
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {editable && (
                            <SubjectPicker label="Invite people" types={['user']}
                                exclude={(members.data ?? []).map(m => subjectKey({ type: 'user', id: m.id }))}
                                onPick={p => actions.addMember.mutate({ groupId: g.id, userId: p.id }, after(`${p.name} joined ${g.shortName}.`))} />
                        )}
                    </Section>

                    <Section title="Identity provider"
                        hint="Link the group to one in Active Directory, Entra, Okta… and people in it join this group when they sign in.">
                        {g.idpLinks.map(l => (
                            <div key={l.mappingId} className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.05] px-3 py-2">
                                <Link2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-semibold text-ink">Follows {l.idpGroup}</span>
                                    <span className="block text-[11px] text-ink-muted">{l.providerName ? `From ${l.providerName}` : 'From any connection'}</span>
                                </span>
                                {isPlatformAdmin && g.owned && (
                                    <button type="button" disabled={actions.unlinkIdp.isPending}
                                        onClick={() => actions.unlinkIdp.mutate({ groupId: g.id, mappingId: l.mappingId }, after(`${g.shortName} no longer follows ${l.idpGroup}.`))}
                                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-ink-secondary hover:bg-rose-500/10 hover:text-rose-600 disabled:opacity-50">
                                        <Unlink className="h-3.5 w-3.5" aria-hidden /> Unlink
                                    </button>
                                )}
                            </div>
                        ))}
                        {g.pendingIdpLink ? (
                            <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5">
                                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                                <p className="text-xs text-ink-secondary">
                                    <span className="font-semibold text-ink">Link to {g.pendingIdpLink.idpGroup} is waiting for a platform administrator.</span>{' '}
                                    {g.pendingIdpLink.requestedByName ? `${g.pendingIdpLink.requestedByName} asked` : 'Asked'} {timeAgo(g.pendingIdpLink.requestedAt)}. You’ll hear in your inbox.
                                </p>
                            </div>
                        ) : editable && g.idpLinks.length === 0 && (
                            <div className="space-y-2">
                                <IdpGroupInput value={idpGroup} onChange={setIdpGroup} />
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-[11px] text-ink-muted">{isPlatformAdmin ? 'Linked straight away.' : 'A platform administrator confirms the link.'}</p>
                                    <button type="button" disabled={!idpGroup.trim() || actions.linkIdp.isPending}
                                        onClick={() => actions.linkIdp.mutate({ groupId: g.id, idpGroup: idpGroup.trim() },
                                            after(isPlatformAdmin ? `${g.shortName} now follows ${idpGroup.trim()}.` : 'Asked — a platform administrator will confirm it.', () => setIdpGroup('')))}
                                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">
                                        {actions.linkIdp.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Link2 className="h-3.5 w-3.5" aria-hidden />}
                                        {isPlatformAdmin ? 'Link' : 'Ask to link'}
                                    </button>
                                </div>
                            </div>
                        )}
                        {!editable && g.idpLinks.length === 0 && !g.pendingIdpLink && (
                            <p className="text-sm text-ink-muted">Not linked.</p>
                        )}
                    </Section>

                    {editable && (
                        <Section title="Delete">
                            {confirmDelete ? (
                                <div className="space-y-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.05] p-3">
                                    <p className="text-xs text-ink-secondary">
                                        Its {g.memberCount === 1 ? 'one person loses' : `${g.memberCount} people lose`} the access it gives — here and anywhere else it’s bound — and its identity-provider link goes. People keep any access they have of their own.
                                    </p>
                                    <div className="flex justify-end gap-2">
                                        <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink">Keep it</button>
                                        <button type="button" disabled={actions.remove.isPending}
                                            onClick={() => actions.remove.mutate(g.id, after(`${g.shortName} was deleted.`, onClose))}
                                            className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
                                            {actions.remove.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Trash2 className="h-3.5 w-3.5" aria-hidden />} Delete group
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button type="button" onClick={() => setConfirmDelete(true)}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:border-rose-500/40 hover:text-rose-600">
                                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete this group
                                </button>
                            )}
                        </Section>
                    )}
                </div>
            </div>
        </>,
        document.body,
    )
}

// ── New group ───────────────────────────────────────────────────────────

export function CreateGroupDialog({ workspaceId, prefix, initial, onClose, onCreated }: {
    workspaceId: string
    /** The workspace's name, which the group's carries. */
    prefix: string
    initial: { name: string; role: GroupRole }
    onClose: () => void
    onCreated: (group: WorkspaceGroup) => void
}) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const isPlatformAdmin = useAuthStore(s => s.can('system:admin'))
    const { create } = useWorkspaceGroupActions(workspaceId)
    const [name, setName] = useState(initial.name)
    const [description, setDescription] = useState('')
    const [role, setRole] = useState<GroupRole>(initial.role)
    const [people, setPeople] = useState<{ id: string; name: string }[]>([])
    const [idpGroup, setIdpGroup] = useState('')
    const [taken, setTaken] = useState<string | null>(null)

    const submit = () => create.mutate(
        { name: name.trim(), description: description.trim() || undefined, role, memberIds: people.map(p => p.id), idpGroup: idpGroup.trim() || undefined },
        {
            onSuccess: g => {
                notify('success', g.pendingIdpLink ? `${g.shortName} is ready — its link waits for a platform administrator.` : `${g.shortName} is ready.`)
                onCreated(g)
            },
            onError: e => {
                const d = (e as { detail?: { type?: string; suggestion?: string } }).detail
                if (d?.type === 'group_name_taken') setTaken(d.suggestion ?? null)
                else notify('error', message(e, 'Couldn’t make the group.'))
            },
        },
    )

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" />
            <div className="pointer-events-none fixed inset-0 z-[61] flex items-center justify-center p-4">
                <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ws-new-group-title" tabIndex={-1}
                    className="pointer-events-auto flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl outline-none">
                    <div className="relative overflow-hidden border-b border-glass-border p-5">
                        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-500/[0.10] via-transparent to-fuchsia-500/[0.06]" />
                        <div className="relative flex items-start gap-3">
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white shadow-md shadow-violet-500/25">
                                <UsersRound className="h-5 w-5" aria-hidden />
                            </span>
                            <div className="min-w-0 flex-1">
                                <h2 id="ws-new-group-title" className="font-display text-lg font-bold text-ink">New group</h2>
                                <p className="text-xs text-ink-secondary">A team that gets access together. Everything here can change later.</p>
                            </div>
                            <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-muted hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.06]">
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    <form className="flex-1 space-y-5 overflow-y-auto custom-scrollbar p-5" onSubmit={e => { e.preventDefault(); if (name.trim()) submit() }}>
                        <div>
                            <input aria-label="Group name" value={name} maxLength={80} autoFocus placeholder="e.g. Analysts"
                                onChange={e => { setName(e.target.value); setTaken(null) }}
                                className={cn('w-full rounded-xl border-2 bg-canvas px-3 py-2.5 text-base font-semibold text-ink outline-none focus:border-indigo-500',
                                    taken !== null ? 'border-rose-400/70' : 'border-black/[0.10] dark:border-white/[0.12]')} />
                            <p className="mt-1 text-[11px] text-ink-muted">
                                {taken !== null ? (
                                    <>That name is taken.{taken && <> <button type="button" onClick={() => { setName(taken); setTaken(null) }} className="font-semibold text-violet-700 underline dark:text-violet-300">Use “{taken}”</button></>}</>
                                ) : name.trim() ? <>Made as “{groupFullName(prefix, name)}”</> : 'Give it a name your colleagues will recognise.'}
                            </p>
                        </div>
                        <textarea aria-label="Description" value={description} maxLength={500} rows={2} onChange={e => setDescription(e.target.value)}
                            placeholder="Who it’s for (optional)"
                            className="w-full resize-none rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas px-3 py-2 text-sm text-ink outline-none focus:border-indigo-500" />

                        <Section title="What they can do here"><RolePicker value={role} onChange={setRole} /></Section>

                        <Section title="People" hint="Optional — anyone with an account here.">
                            {people.length > 0 && (
                                <ul aria-label="Invited" className="flex flex-wrap gap-1.5">
                                    {people.map(p => (
                                        <li key={p.id} className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 py-1 pl-2.5 pr-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
                                            {p.name}
                                            <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPeople(ps => ps.filter(x => x.id !== p.id))}
                                                className="rounded-full p-0.5 hover:bg-indigo-500/20"><X className="h-3 w-3" /></button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <SubjectPicker label="Invite people" types={['user']}
                                exclude={people.map(p => subjectKey({ type: 'user', id: p.id }))}
                                onPick={p => setPeople(ps => [...ps, { id: p.id, name: p.name }])} />
                        </Section>

                        <Section title="Link to your identity provider"
                            hint={`Optional — people in this directory group join at sign-in. ${isPlatformAdmin ? 'You can link it straight away.' : 'A platform administrator confirms the link.'}`}>
                            <IdpGroupInput value={idpGroup} onChange={setIdpGroup} />
                        </Section>
                    </form>

                    <div className="flex items-center justify-end gap-2 border-t border-glass-border px-5 py-3">
                        <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-semibold text-ink-secondary hover:text-ink">Cancel</button>
                        <button type="button" disabled={!name.trim() || create.isPending} onClick={submit}
                            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-violet-500/25 hover:brightness-110 disabled:opacity-50">
                            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />} Create group
                        </button>
                    </div>
                </div>
            </div>
        </>,
        document.body,
    )
}
