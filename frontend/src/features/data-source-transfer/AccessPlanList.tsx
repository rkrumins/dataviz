/**
 * AccessPlanList — who keeps, gains and loses access when the views move.
 *
 * Nothing is decided here. The destination's own membership governs the moved
 * views, so the list says what that means: owners and anyone a view is shared
 * with keep it, the destination's members start seeing its workspace views,
 * and the people and groups who read them only because they're in the old
 * workspace lose them. Each of those says where their access came from, which
 * is how it can be given back: added in the destination, or — when the identity
 * provider decides — its group mapped there.
 */
import { useMemo, useState } from 'react'
import { CheckCircle2, Fingerprint, Search, ShieldCheck, UserMinus, UserPlus, Users } from 'lucide-react'

import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { cn } from '@/lib/utils'
import type { TransferAccess, TransferSubject } from '@/services/dataSourceTransferService'
import { plural, subjectKey, whoLoses } from './transferCopy'

const SEARCH_FROM = 10

export function AccessPlanList({ access, fromName, toName, requestMode = false }: {
    access: TransferAccess
    fromName: string
    toName: string
    /** Someone else (the destination's admins) will make the move. */
    requestMode?: boolean
}) {
    const [query, setQuery] = useState('')
    const loses = access.loses
    const groups = loses.filter(s => s.type === 'group').length
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return loses
        return loses.filter(s => s.name.toLowerCase().includes(q) || (s.email ?? '').toLowerCase().includes(q))
    }, [loses, query])

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <SummaryCard icon={ShieldCheck} tone="emerald" label="Keeps access" headline="Nothing changes">
                    <ul className="space-y-0.5">
                        <li>{plural(access.creators, 'owner')} keep their views</li>
                        <li>{plural(access.sharedWith, 'person or group', 'people and groups')} it’s shared with</li>
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
                    label="Loses access"
                    headline={loses.length ? whoLoses(loses.length - groups, groups) : 'No one'}
                >
                    {loses.length
                        ? `They’re told how to ask to join ${toName}${requestMode ? ' once its admins accept' : ''}`
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
                <section aria-label="People and groups who lose access" className="rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated overflow-hidden">
                    <div className="px-4 py-3 border-b border-black/[0.08] dark:border-white/[0.10]">
                        <h4 className="text-sm font-bold text-ink">In {fromName}, not in {toName}</h4>
                        <p className="text-[11px] text-ink-muted">
                            They read these views today because they’re in {fromName}. After the move they don’t.
                        </p>
                    </div>
                    {loses.length > SEARCH_FROM && (
                        <div className="px-4 pt-3">
                            <div className="relative">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" aria-hidden />
                                <input
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder="Find a person or group"
                                    aria-label="Find a person or group"
                                    className="input h-8 w-full pl-8 text-xs"
                                />
                            </div>
                        </div>
                    )}
                    <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
                        {shown.map(s => <SubjectRow key={subjectKey(s)} subject={s} fromName={fromName} toName={toName} />)}
                        {shown.length === 0 && (
                            <li className="px-4 py-4 text-xs text-ink-muted text-center">No one matches “{query}”.</li>
                        )}
                    </ul>
                </section>
            )}

            {loses.length > 0 && (
                <p className="text-[11px] leading-relaxed text-ink-muted">
                    To give someone access in {toName}, add them or their group there. Where your identity
                    provider decides, map their identity-provider group to {toName} instead, so it keeps deciding.
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

function SubjectRow({ subject: s, fromName, toName }: { subject: TransferSubject; fromName: string; toName: string }) {
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
                <p className="text-sm font-semibold text-ink truncate">
                    {s.name}
                    {s.type === 'group' && s.memberCount != null && (
                        <span className="ml-1.5 text-[11px] font-normal text-ink-muted">group · {plural(s.memberCount, 'member')}</span>
                    )}
                </p>
                <p className="text-[11px] text-ink-muted truncate">
                    {s.role} in {fromName} · reads {plural(s.views, 'view')}
                    {s.type === 'user' && s.email && s.email !== s.name && <> · {s.email}</>}
                </p>
            </div>
            {s.via === 'idp' && (
                <HoverTip
                    label="From your identity provider"
                    detail={`Map their identity-provider group to ${toName} to give them access there.`}
                >
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-600 dark:text-sky-400">
                        <Fingerprint className="w-3 h-3" aria-hidden />
                        Identity provider
                    </span>
                </HoverTip>
            )}
        </li>
    )
}
