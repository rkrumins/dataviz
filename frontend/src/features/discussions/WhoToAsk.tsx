/**
 * WhoToAsk — the people who look after a view or a data source, and why each of them: who made
 * the view and who can edit it, the data's named owner and stewards (or, where nobody is named,
 * whoever connected or asked for it), and the workspace's admins when there is nobody else. Each
 * is a person chip with their card on hover; Ask a question opens the drawer's ask box.
 *
 * `strip` is the one-line form the questions panel leads with.
 */
import { useId } from 'react'
import { MessageCircleQuestion, UserRoundSearch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PersonChip } from '@/components/ui/PersonChip'
import { AvatarStack } from '@/components/ui/AvatarStack'
import { Skeleton } from '@/components/ui/Skeleton'
import type { PeopleMap, PersonRole } from '@/services/discussionsService'
import { useConversationsEnabled, useSubjectPeople } from './useDiscussions'
import { useDiscussionsDrawer, type DrawerSubject } from './drawerStore'
import { VIA_CAPTION, listNames, nameOf, stackPerson, subjectNoun } from './discussionText'

const caption = (r: PersonRole) => (r.groupName ? `${VIA_CAPTION[r.via]} · via ${r.groupName}` : VIA_CAPTION[r.via])

function People({ title, roles, people }: { title: string; roles: PersonRole[]; people: PeopleMap }) {
    if (roles.length === 0) return null
    return (
        <div className="space-y-1.5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">{title}</p>
            <ul className="space-y-2">
                {roles.map((r) => {
                    const p = people[r.personId]
                    return (
                        <li key={`${r.personId}:${r.via}`} className="flex items-center gap-2 min-w-0">
                            <PersonChip id={r.personId} size="md" caption={caption(r)}
                                person={p ? { displayName: p.deleted ? 'Former member' : p.displayName, email: p.email, deleted: p.deleted, avatarId: p.avatarId, hasImage: p.hasImage } : undefined} />
                            {!r.canRead && (
                                <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-px text-[9.5px] font-semibold text-amber-700 dark:text-amber-300">Can’t open it</span>
                            )}
                        </li>
                    )
                })}
            </ul>
        </div>
    )
}

export interface WhoToAskProps {
    subject: DrawerSubject
    /** `strip`: one line of faces and names (the questions panel); `full`: each person, and why. */
    variant?: 'full' | 'strip'
    /** Ask a question; by default the questions drawer opens with its ask box. */
    onAsk?: () => void
    className?: string
}

export function WhoToAsk({ subject, variant = 'full', onAsk, className }: WhoToAskProps) {
    const on = useConversationsEnabled()
    const q = useSubjectPeople(subject)
    const open = useDiscussionsDrawer((s) => s.open)
    const titleId = useId()
    if (!on) return null
    const ask = onAsk ?? (() => open({ subject, compose: true }))
    const d = q.data
    const people = d?.people ?? {}
    const owners = d?.viewOwners ?? []
    const dataOwner = d?.dataContacts.owner ? [d.dataContacts.owner] : []
    const stewards = d?.dataContacts.stewards ?? []
    const named = [...owners, ...dataOwner, ...stewards]
    const everyone = [...new Map(named.map((r) => [r.personId, r])).values()]
    const shown = everyone.length ? everyone : d?.fallback ?? []
    const noun = subjectNoun(subject)

    if (variant === 'strip') {
        if (q.isLoading) {
            return <div className={cn('flex items-center gap-2', className)} aria-busy="true"><Skeleton className="w-16 h-6 rounded-full" /><Skeleton className="h-3 w-40" /></div>
        }
        if (shown.length === 0) return null
        const names = shown.map((r) => nameOf(r.personId, people))
        return (
            <div className={cn('flex items-center gap-2.5 min-w-0', className)}>
                <AvatarStack people={shown.map((r) => stackPerson(r.personId, people))} max={4} size="sm" label="Who to ask" />
                <p className="min-w-0 text-[11.5px] leading-snug text-ink-muted">
                    <span className="font-semibold text-ink-secondary">{listNames(names, 3)}</span>
                    {everyone.length ? ` ${shown.length === 1 ? 'looks' : 'look'} after ${noun}` : ' — the workspace’s admins, as nobody is named yet'}
                </p>
            </div>
        )
    }

    return (
        <section aria-labelledby={titleId} className={cn('rounded-2xl border border-glass-border/70 bg-canvas-elevated/60 p-4 space-y-3', className)}>
            <div className="flex items-center gap-2">
                <span className="flex w-7 h-7 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    <UserRoundSearch className="w-3.5 h-3.5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                    <h3 id={titleId} className="text-[13px] font-bold text-ink">Who to ask</h3>
                    <p className="text-[11px] text-ink-muted">The people who look after {noun} and the data under it</p>
                </div>
            </div>
            {q.isLoading ? (
                <div className="space-y-2" aria-busy="true">
                    {[0, 1].map((i) => <div key={i} className="flex items-center gap-2"><Skeleton className="w-8 h-8 rounded-full" /><Skeleton className="h-3 w-32" /></div>)}
                </div>
            ) : q.isError ? (
                <p className="text-[12px] text-ink-muted">Couldn’t find out who looks after {noun} just now.</p>
            ) : (
                <div className="space-y-3">
                    <People title={owners.length === 1 ? 'View owner' : 'View owners'} roles={owners} people={people} />
                    <People title="Data owner" roles={dataOwner} people={people} />
                    <People title={stewards.length === 1 ? 'Data steward' : 'Data stewards'} roles={stewards} people={people} />
                    {d && d.dataContacts.provenance === 'derived' && (dataOwner.length > 0 || stewards.length > 0) && (
                        <p className="text-[11px] text-ink-muted">Nobody is named for the data yet: these are the people who connected it or asked for it.</p>
                    )}
                    {everyone.length === 0 && (
                        <>
                            <People title="Workspace admins" roles={d?.fallback ?? []} people={people} />
                            <p className="text-[11px] text-ink-muted">Nobody is named to look after {noun} yet, so questions go to the workspace’s admins.</p>
                        </>
                    )}
                    {d && d.truncated > 0 && (
                        <p className="text-[11px] text-ink-muted">And {d.truncated.toLocaleString()} more in large groups, not listed.</p>
                    )}
                </div>
            )}
            <button type="button" onClick={ask}
                className="inline-flex items-center gap-1.5 rounded-xl bg-accent-lineage px-3 h-8 text-[12px] font-semibold text-white shadow-sm shadow-accent-lineage/25 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas">
                <MessageCircleQuestion className="w-3.5 h-3.5" aria-hidden />Ask a question
            </button>
        </section>
    )
}
