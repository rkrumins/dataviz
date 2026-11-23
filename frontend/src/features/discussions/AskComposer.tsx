/**
 * AskComposer — asking a question about a view or a data source.
 *
 * Read top to bottom like a message: who it goes to (the view's owners and the data's owners,
 * each a toggle with their faces, both on for a view; anyone else by name), who can see it
 * (everyone who can open the subject, or only the people involved — spelled out in plain words),
 * then the question itself, with `@` to mention and ⌘↵ to ask.
 *
 * Someone who can't open the subject can't be asked: they are named before it is sent, and
 * again after if the server found more — with **Share** beside them, for whoever can change who
 * sees the view, and a fresh look at who can be reached once the dialog closes. Nobody named to
 * look after it? It goes to the workspace's admins, and the composer says so.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, Globe, Lock, MapPin, Plus, Search, Share2, Users, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AvatarStack } from '@/components/ui/AvatarStack'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import { CommentComposer } from '@/features/reviews/comments/CommentComposer'
import { ShareViewDialog } from '@/components/views/ShareViewDialog'
import { useViewAccess } from '@/hooks/useViewMetadata'
import type { MentionCandidate } from '@/features/reviews/comments/mentions'
import { useAuthStore } from '@/store/auth'
import type { AskResult, PeopleMap, PersonRole, SubjectKey, Visibility } from '@/services/discussionsService'
import { useDiscussionActions, useMentionSource, useMentionable, useSubjectPeople } from './useDiscussions'
import type { DrawerEntity } from './drawerStore'
import { listNames, nameOf, stackPerson, subjectNoun } from './discussionText'

const MAX_RECIPIENTS = 20

export interface AskComposerProps {
    subject: SubjectKey & { name?: string | null }
    /** The node the question is about, if any. */
    entity?: DrawerEntity | null
    /** Ask about the whole subject instead of `entity`. */
    onClearEntity?: () => void
    /** People to ask besides the routes (a profile's "Ask a question"). */
    initialRecipients?: string[]
    /** Asked: the new thread, and who it reached. */
    onAsked: (result: AskResult) => void
    onCancel?: () => void
    autoFocus?: boolean
    className?: string
}

const uniq = (roles: readonly (PersonRole | null | undefined)[]) => {
    const seen = new Set<string>()
    return roles.filter((r): r is PersonRole => !!r && !seen.has(r.personId) && !!seen.add(r.personId))
}

/** One route: a toggle with the people it reaches. */
function RouteToggle({ label, on, onChange, roles, people, loading }: {
    label: string; on: boolean; onChange: (on: boolean) => void; roles: PersonRole[]; people: PeopleMap | undefined; loading: boolean
}) {
    const names = roles.map((r) => nameOf(r.personId, people))
    return (
        <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} disabled={!loading && roles.length === 0}
            aria-label={`${label} (${roles.length})${names.length ? `: ${listNames(names, 4)}` : ''}`}
            className={cn('group inline-flex items-center gap-2 rounded-xl border pl-2 pr-2.5 h-9 text-[12px] font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 disabled:opacity-50 disabled:cursor-not-allowed',
                on ? 'border-accent-lineage/40 bg-accent-lineage/[0.07] text-ink' : 'border-glass-border/70 text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.04]')}>
            <span aria-hidden className={cn('flex w-4 h-4 items-center justify-center rounded-[5px] border transition-colors',
                on ? 'border-accent-lineage bg-accent-lineage text-white' : 'border-ink-muted/40')}>
                {on && <Check className="w-3 h-3" strokeWidth={3} />}
            </span>
            <span>{label} <span className="tabular-nums text-ink-muted">({loading ? '…' : roles.length})</span></span>
            {loading ? <Skeleton className="w-10 h-5 rounded-full" />
                : <AvatarStack people={roles.map((r) => stackPerson(r.personId, people))} max={3} size="xs" ring="ring-canvas" className={cn(!on && 'opacity-60')} />}
        </button>
    )
}

/** "+ Add people": anyone who can open the subject, found by name. */
function AddPeople({ subject, exclude, onAdd, disabled }: {
    subject: SubjectKey; exclude: ReadonlySet<string>; onAdd: (p: MentionCandidate) => void; disabled?: boolean
}) {
    const [open, setOpen] = useState(false)
    const [q, setQ] = useState('')
    const [active, setActive] = useState(0)
    const found = useMentionable(subject, q, open)
    const list = (found.data ?? []).filter((p) => !exclude.has(p.id)).slice(0, 6)
    const at = Math.min(active, Math.max(0, list.length - 1))
    const listId = `add-people-${useId().replace(/:/g, '')}`
    const pick = (p: MentionCandidate) => { onAdd(p); setQ(''); setActive(0) }

    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)} disabled={disabled}
                className="inline-flex items-center gap-1 rounded-xl border border-dashed border-glass-border/70 px-2.5 h-9 text-[12px] font-semibold text-ink-muted hover:text-ink hover:border-ink-muted/40 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <Plus className="w-3.5 h-3.5" aria-hidden />Add people
            </button>
        )
    }
    return (
        <div className="relative w-full sm:w-64">
            <div className="flex items-center gap-1.5 rounded-xl border border-glass-border/70 bg-canvas px-2.5 h-9 focus-within:ring-2 focus-within:ring-accent-lineage/40">
                <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />
                <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }}
                    placeholder="Find someone who can see it…" aria-label="Find someone to ask"
                    role="combobox" aria-expanded={list.length > 0} aria-controls={listId} aria-autocomplete="list"
                    aria-activedescendant={list.length ? `${listId}-${at}` : undefined}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); setActive((at + 1) % list.length) }
                        else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); setActive((at - 1 + list.length) % list.length) }
                        else if (e.key === 'Enter' && list[at]) { e.preventDefault(); pick(list[at]) }
                        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); setQ('') }
                    }}
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink placeholder:text-ink-muted/60 focus:outline-none" />
                <button type="button" aria-label="Stop adding people" onClick={() => { setOpen(false); setQ('') }}
                    className="text-ink-muted hover:text-ink"><X className="w-3.5 h-3.5" aria-hidden /></button>
            </div>
            {list.length > 0 && (
                <ul id={listId} role="listbox" aria-label="People who can see it"
                    className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl border border-glass-border/70 bg-canvas-elevated shadow-glass-lg py-1">
                    {list.map((p, i) => (
                        <li key={p.id} id={`${listId}-${i}`} role="option" aria-selected={i === at}
                            onMouseDown={(e) => { e.preventDefault(); pick(p) }} onMouseEnter={() => setActive(i)}
                            className={cn('mx-1 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5', i === at && 'bg-accent-lineage/10')}>
                            <UserAvatar userId={p.id} name={p.name} avatarId={p.avatarId} hasImage={p.hasImage} className="w-6 h-6 text-[9px] font-bold" />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-medium text-ink">{p.name}</span>
                                {p.email && <span className="block truncate text-[10.5px] text-ink-muted">{p.email}</span>}
                            </span>
                            {p.hint && <span className="shrink-0 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-1.5 py-px text-[9.5px] font-semibold text-ink-secondary">{p.hint}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

export function AskComposer({ subject, entity, onClearEntity, initialRecipients, onAsked, onCancel, autoFocus, className }: AskComposerProps) {
    const me = useAuthStore((s) => s.user?.id)
    const { notify } = useAppNotifications()
    const peopleQ = useSubjectPeople(subject)
    const mentionSource = useMentionSource(subject)
    const { ask } = useDiscussionActions()
    const isView = subject.type === 'view'
    const [route, setRoute] = useState({ viewOwners: isView, dataContacts: true })
    const [visibility, setVisibility] = useState<Visibility>('open')
    const [recipients, setRecipients] = useState<MentionCandidate[]>(
        () => (initialRecipients ?? []).map((id) => ({ id, name: id })),
    )
    // Who may bring someone in: whoever can share the view or change who sees it.
    const theView = useViewAccess(isView ? subject.id : null)
    const canShare = !!theView.access && (theView.access.canManageGrants || theView.access.canChangeVisibility)
    const [sharing, setSharing] = useState(false)
    const { refetch: refetchPeople } = peopleQ
    // Shared, or not: ask again who can open it.
    const doneSharing = useCallback(() => { setSharing(false); void refetchPeople() }, [refetchPeople])
    useEffect(() => {
        if (!sharing) return
        // Esc closes the dialog, not the drawer behind it (whose own Esc would drop the question).
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); doneSharing() } }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [sharing, doneSharing])

    const data = peopleQ.data
    const loading = peopleQ.isLoading
    const people = useMemo<PeopleMap>(() => ({ ...data?.people }), [data])
    const owners = useMemo(() => uniq(data?.viewOwners ?? []).filter((r) => r.personId !== me), [data, me])
    const contacts = useMemo(() => uniq([data?.dataContacts.owner, ...(data?.dataContacts.stewards ?? [])]).filter((r) => r.personId !== me), [data, me])
    const fallback = useMemo(() => uniq(data?.fallback ?? []).filter((r) => r.personId !== me), [data, me])

    const routed = [...(route.viewOwners && isView ? owners : []), ...(route.dataContacts ? contacts : [])]
    const cantRead = uniq(routed).filter((r) => !r.canRead)
    const reachesNobody = !loading && uniq(routed).filter((r) => r.canRead).length === 0 && recipients.length === 0
    const noun = subjectNoun(subject)
    const recipientName = (r: MentionCandidate) => (r.name === r.id ? nameOf(r.id, people) : r.name)
    // Add people offers only whoever isn't asked already: not the reader, not those added, not
    // those a route on reaches.
    const exclude = new Set([...recipients.map((r) => r.id), ...(me ? [me] : []), ...routed.filter((r) => r.canRead).map((r) => r.personId)])

    const submit = async (body: string, mentions: string[], clientKey: string) => {
        const res = await ask.mutateAsync({
            subject,
            input: {
                body, visibility, mentions, clientKey,
                route: { viewOwners: isView && route.viewOwners, dataContacts: route.dataContacts },
                recipientIds: recipients.map((r) => r.id),
                ...(entity ? { entityId: entity.id, entityLabel: entity.label } : {}),
            },
        })
        if (res.notReached.length) {
            const names = res.notReached.map((n) => nameOf(n.personId, res.thread.people))
            notify('warning', `Asked. ${listNames(names, 3)} can’t open ${noun}, so ${names.length === 1 ? 'wasn’t' : 'weren’t'} told — share it with them to bring them in.`)
        } else if (res.usedFallback) {
            notify('success', 'Asked. Nobody is named to look after it yet, so the workspace’s admins were told.')
        } else {
            notify('success', res.reached.length ? `Asked ${res.reached.length === 1 ? nameOf(res.reached[0], res.thread.people) : `${res.reached.length} people`}` : 'Asked')
        }
        onAsked(res)
    }

    return (
        <div className={cn('rounded-2xl border border-glass-border/70 bg-canvas p-3.5 space-y-3 shadow-sm', className)}>
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-bold text-ink">Ask a question</h3>
                {entity && (
                    <span className="inline-flex items-center gap-1 min-w-0 max-w-full rounded-lg border border-amber-500/25 bg-amber-500/[0.07] pl-1.5 pr-1 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200">
                        <MapPin className="w-3 h-3 shrink-0" aria-hidden />About <span className="truncate font-semibold">{entity.label}</span>
                        {onClearEntity && (
                            <button type="button" onClick={onClearEntity} aria-label={`Ask about all of ${noun} instead`}
                                className="ml-0.5 rounded p-0.5 hover:bg-amber-500/15"><X className="w-3 h-3" aria-hidden /></button>
                        )}
                    </span>
                )}
            </div>

            <fieldset className="min-w-0 space-y-2">
                <legend className="mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">Send to</legend>
                <div className="flex flex-wrap items-center gap-2">
                    {isView && (
                        <RouteToggle label="View’s owners" on={route.viewOwners} onChange={(v) => setRoute((r) => ({ ...r, viewOwners: v }))}
                            roles={owners} people={people} loading={loading} />
                    )}
                    <RouteToggle label="Data owners" on={route.dataContacts} onChange={(v) => setRoute((r) => ({ ...r, dataContacts: v }))}
                        roles={contacts} people={people} loading={loading} />
                    {recipients.map((r) => (
                        <span key={r.id} className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-glass-border/70 bg-black/[0.02] dark:bg-white/[0.03] pl-1.5 pr-1 h-9 text-[12px] font-semibold text-ink">
                            <UserAvatar userId={r.id} name={recipientName(r)} avatarId={r.avatarId ?? people[r.id]?.avatarId} hasImage={r.hasImage ?? people[r.id]?.hasImage} className="w-6 h-6 text-[9px] font-bold" />
                            <span className="truncate">{recipientName(r)}</span>
                            <button type="button" aria-label={`Don’t ask ${recipientName(r)}`} onClick={() => setRecipients((rs) => rs.filter((x) => x.id !== r.id))}
                                className="shrink-0 rounded-md p-0.5 text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"><X className="w-3 h-3" aria-hidden /></button>
                        </span>
                    ))}
                    <AddPeople subject={subject} exclude={exclude} disabled={recipients.length >= MAX_RECIPIENTS}
                        onAdd={(p) => setRecipients((rs) => (rs.length >= MAX_RECIPIENTS ? rs : [...rs, p]))} />
                </div>
                {cantRead.length > 0 && (
                    <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/[0.08] px-2.5 py-1.5 text-[11.5px] text-amber-800 dark:text-amber-200">
                        <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1">
                            {listNames(cantRead.map((r) => nameOf(r.personId, people)), 3)} can’t open {noun}, so won’t be asked.
                            {' '}Share {noun} with them first to bring them in.
                        </span>
                        {canShare && (
                            <button type="button" onClick={() => setSharing(true)} aria-label={`Share ${noun}`}
                                className="-my-0.5 inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-500/30 bg-canvas/70 px-2 py-0.5 text-[11.5px] font-semibold text-amber-800 dark:text-amber-200 hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40">
                                <Share2 className="w-3 h-3" aria-hidden />Share
                            </button>
                        )}
                    </p>
                )}
                {sharing && theView.view && createPortal(
                    // In the body, not the drawer: the drawer slides in on a transform, which would
                    // pin a fixed dialog inside it.
                    <ShareViewDialog viewId={theView.view.id} viewName={theView.view.name}
                        currentVisibility={theView.view.visibility} workspaceId={theView.view.workspaceId}
                        access={theView.access} publishRequest={theView.view.publishRequest} isOpen
                        onClose={doneSharing} />,
                    document.body,
                )}
                {reachesNobody && (
                    <p className="flex items-center gap-2 text-[11.5px] text-ink-muted">
                        {fallback.length > 0 ? (
                            <>
                                <AvatarStack people={fallback.map((r) => stackPerson(r.personId, people))} max={3} size="xs" ring="ring-canvas" label="Workspace admins" />
                                <span>Nobody here can be asked, so it goes to the workspace’s admins ({listNames(fallback.map((r) => nameOf(r.personId, people)), 3)}).</span>
                            </>
                        ) : (
                            <span>Nobody will be told. It will wait here for whoever opens {noun} next.</span>
                        )}
                    </p>
                )}
            </fieldset>

            <fieldset className="space-y-1.5">
                <legend className="mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">Who can see it</legend>
                <Segmented<Visibility> label="Who can see it" value={visibility} onChange={setVisibility} className="flex w-full flex-col items-stretch sm:inline-flex sm:w-fit sm:flex-row sm:items-center"
                    options={[
                        { value: 'open', label: `Everyone who can see ${noun}`, icon: Globe },
                        { value: 'private', label: 'Only the people involved', icon: Lock },
                    ]} />
                <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-ink-muted">
                    {visibility === 'private' ? (
                        <><Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
                            Only you, the people you ask or mention, anyone who replies, {noun}’s owners and the workspace’s admins will see it.</>
                    ) : (
                        <><Users className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
                            Anyone who can open {noun} can read it and reply — and the answer helps the next person who wonders.</>
                    )}
                </p>
            </fieldset>

            <CommentComposer
                mentionSource={mentionSource}
                autoFocus={autoFocus}
                placeholder={entity ? `What would you like to know about ${entity.label}?` : 'What would you like to know?'}
                submitLabel="Ask"
                onCancel={onCancel}
                onSubmit={submit}
            />
        </div>
    )
}
