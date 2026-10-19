/**
 * AccessPlanList — who keeps, gains and would lose access when the views move.
 *
 * Owners and anyone a view is shared with keep it without anyone deciding
 * anything, and the destination's members start seeing its workspace views;
 * the summary cards say so in numbers. What needs a decision is the people
 * and teams who read the views today only because they're in the old
 * workspace: each row keeps their access — view-only, to exactly these
 * views — or lets it go. In the review dialog the same list is read-only:
 * the reviewer sees what the proposer chose.
 */
import { useMemo, useState } from 'react'
import { CheckCircle2, Search, ShieldCheck, UserMinus, UserPlus, Users } from 'lucide-react'

import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { cn } from '@/lib/utils'
import type { TransferAccess, TransferSubject } from '@/services/dataSourceTransferService'
import { plural, subjectKey } from './transferCopy'

const SEARCH_FROM = 10

export function AccessPlanList({
    access, fromName, toName, isKept, onToggle, onSetAll, readOnly = false, requestMode = false,
}: {
    access: TransferAccess
    fromName: string
    toName: string
    isKept: (s: TransferSubject) => boolean
    onToggle?: (s: TransferSubject, keep: boolean) => void
    onSetAll?: (keep: boolean) => void
    readOnly?: boolean
    /** The proposer is choosing for someone else to approve. */
    requestMode?: boolean
}) {
    const [query, setQuery] = useState('')
    const loses = access.loses
    const kept = loses.filter(isKept).length
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return loses
        return loses.filter(s => s.name.toLowerCase().includes(q) || (s.email ?? '').toLowerCase().includes(q))
    }, [loses, query])

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <SummaryCard icon={ShieldCheck} tone="emerald" label="Keeps access" headline="Nothing to do">
                    <ul className="space-y-0.5">
                        <li>{plural(access.creators, 'owner')} keep their views</li>
                        <li>{plural(access.sharedWith, 'person or team', 'people and teams')} it’s shared with</li>
                        {access.everyone > 0 && <li>{plural(access.everyone, 'view')} published to everyone</li>}
                    </ul>
                </SummaryCard>
                <SummaryCard icon={UserPlus} tone="sky" label="Gains access" headline={plural(access.gainsPeople, 'person', 'people')}>
                    <ul className="space-y-0.5">
                        <li>{toName}’s members see {plural(access.gainsViews, 'workspace view')}</li>
                        {access.adminViews > 0 && <li>Its admins can open {plural(access.adminViews, 'private view')}</li>}
                    </ul>
                </SummaryCard>
                <SummaryCard
                    icon={UserMinus}
                    tone="amber"
                    label="Would lose access"
                    headline={loses.length ? plural(loses.length, 'person or team', 'people and teams') : 'No one'}
                >
                    {loses.length
                        ? readOnly ? `${kept} kept as proposed` : 'Choose who keeps it below'
                        : `Everyone who reads these views can still read them in ${toName}`}
                </SummaryCard>
            </div>

            {loses.length === 0 ? (
                <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.05] px-5 py-6 text-center">
                    <CheckCircle2 className="w-6 h-6 mx-auto text-emerald-500" aria-hidden />
                    <p className="mt-2 text-sm font-semibold text-ink">No one loses access</p>
                    <p className="mt-0.5 text-xs text-ink-muted">Nobody reads these views only because they’re in {fromName}.</p>
                </div>
            ) : (
                <section aria-label="People and teams who would lose access" className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated overflow-hidden">
                    <div className="px-4 py-3 border-b border-black/[0.08] dark:border-white/[0.10] flex flex-wrap items-center gap-3">
                        <div className="min-w-0">
                            <h4 className="text-sm font-bold text-ink">In {fromName}, not in {toName}</h4>
                            <p className="text-[11px] text-ink-muted" aria-live="polite">
                                <span className="font-semibold tabular-nums text-ink">{kept} of {loses.length}</span> keep access
                            </p>
                        </div>
                        {!readOnly && onSetAll && (
                            <div className="ml-auto flex items-center gap-1">
                                <button type="button" onClick={() => onSetAll(true)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                                    Keep all
                                </button>
                                <button type="button" onClick={() => onSetAll(false)} className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                                    Remove all
                                </button>
                            </div>
                        )}
                    </div>
                    {loses.length > SEARCH_FROM && (
                        <div className="px-4 pt-3">
                            <div className="relative">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" aria-hidden />
                                <input
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder="Find a person or team"
                                    aria-label="Find a person or team"
                                    className="input h-8 w-full pl-8 text-xs"
                                />
                            </div>
                        </div>
                    )}
                    <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
                        {shown.map(s => (
                            <SubjectRow
                                key={subjectKey(s)}
                                subject={s}
                                fromName={fromName}
                                kept={isKept(s)}
                                readOnly={readOnly}
                                onToggle={onToggle}
                            />
                        ))}
                        {shown.length === 0 && (
                            <li className="px-4 py-4 text-xs text-ink-muted text-center">No one matches “{query}”.</li>
                        )}
                    </ul>
                </section>
            )}

            {loses.length > 0 && (
                <p className="text-[11px] leading-relaxed text-ink-muted">
                    Keeping access shares only these views, view-only. It doesn’t add anyone to {toName}.
                    {requestMode && <> {toName}’s admins will see who you chose.</>}
                </p>
            )}
        </div>
    )
}

const TONES = {
    emerald: { tile: 'bg-emerald-500/10 text-emerald-500', border: 'border-emerald-500/20' },
    sky: { tile: 'bg-sky-500/10 text-sky-500', border: 'border-sky-500/20' },
    amber: { tile: 'bg-amber-500/10 text-amber-500', border: 'border-amber-500/20' },
} as const

function SummaryCard({ icon: Icon, tone, label, headline, children }: {
    icon: typeof Users
    tone: keyof typeof TONES
    label: string
    headline: string
    children: React.ReactNode
}) {
    const t = TONES[tone]
    return (
        <div className={cn('rounded-2xl border bg-canvas-elevated p-4', t.border)}>
            <div className="flex items-center gap-2">
                <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', t.tile)}>
                    <Icon className="w-3.5 h-3.5" aria-hidden />
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</span>
            </div>
            <p className="mt-2.5 text-sm font-bold text-ink">{headline}</p>
            <div className="mt-1 text-[11px] leading-relaxed text-ink-muted">{children}</div>
        </div>
    )
}

function SubjectRow({ subject: s, fromName, kept, readOnly, onToggle }: {
    subject: TransferSubject
    fromName: string
    kept: boolean
    readOnly: boolean
    onToggle?: (s: TransferSubject, keep: boolean) => void
}) {
    const id = `keep-${s.type}-${s.id}`
    return (
        <li className="px-4 py-2 flex items-center gap-3">
            {s.type === 'group' ? (
                <span className="w-8 h-8 rounded-lg bg-violet-500/10 text-violet-500 flex items-center justify-center shrink-0" aria-hidden>
                    <Users className="w-4 h-4" />
                </span>
            ) : (
                <UserAvatar userId={s.id} name={s.name} shape="gradient" className="w-8 h-8 text-[11px] font-bold shrink-0" />
            )}
            <div className="min-w-0 flex-1">
                <label htmlFor={readOnly ? undefined : id} className="block text-sm font-semibold text-ink truncate">
                    {s.name}
                    {s.type === 'group' && s.memberCount != null && (
                        <span className="ml-1.5 text-[11px] font-normal text-ink-muted">team · {plural(s.memberCount, 'member')}</span>
                    )}
                </label>
                <p className="text-[11px] text-ink-muted truncate">
                    {s.role} in {fromName} · reads {plural(s.views, 'view')}
                    {s.type === 'user' && s.email && s.email !== s.name && <> · {s.email}</>}
                </p>
            </div>
            {readOnly ? (
                <span className={cn(
                    'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                    kept
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'border-black/[0.08] dark:border-white/[0.10] text-ink-muted',
                )}>
                    {kept ? 'Keeps access' : 'Loses access'}
                </span>
            ) : (
                <span className="flex items-center gap-1.5 shrink-0">
                    <span className={cn('text-[11px] font-medium', kept ? 'text-ink' : 'text-ink-muted')}>
                        {kept ? 'Keep access' : 'Let go'}
                    </span>
                    <ToggleSwitch
                        id={id}
                        size="sm"
                        checked={kept}
                        onChange={keep => onToggle?.(s, keep)}
                        aria-label={`Keep ${s.name}’s access`}
                    />
                </span>
            )}
        </li>
    )
}
