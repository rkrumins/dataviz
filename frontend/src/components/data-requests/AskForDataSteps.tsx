/**
 * The Ask for data wizard's steps: what data and from where, why and by when (and who
 * knows it), and a last look with what happens next. Each is a centred column with a
 * hero question, in the ViewWizard idiom (`InviteWizard/ui`).
 */
import { CalendarClock, Inbox, MessageSquareText, Search, Send, Target, UserRound, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataRequestDraft } from '@/services/dataRequestsService'
import { SubjectPicker, subjectKey } from '@/components/serviceAccounts/SubjectPicker'
import { BigInput, BigTextarea, FieldLabel, Hint, StepBlock, StepColumn, StepHero } from '@/components/admin/InviteWizard/ui'
import { SYSTEMS, URGENCIES, systemOf, urgencyOf } from './systems'
import { SystemTile } from './SystemTile'
import { DataRequestProgress } from './DataRequestProgress'

export const TITLE_MAX = 120

export interface PersonChip { id: string; name: string; detail?: string }

/** The draft as the wizard holds it: no system until one is picked. */
export type AskDraft = Omit<DataRequestDraft, 'system'> & { system: DataRequestDraft['system'] | null }
type Patch = (patch: Partial<AskDraft>) => void

// ── 1. What ─────────────────────────────────────────────────────────────
export function WhatStep({ draft, onChange, workspaceName }: { draft: AskDraft; onChange: Patch; workspaceName: string }) {
    const chosen = draft.system ? systemOf(draft.system) : null
    const length = draft.title.trim().length
    return (
        <StepColumn wide>
            <StepHero pill={`Data for ${workspaceName}`} pillIcon={Search} title="What data do you need?"
                subtitle="Pick where it lives — your best guess is fine. The platform team connects it; you won’t need to configure anything." />
            <StepBlock delay={0.04}>
                <div role="radiogroup" aria-label="Where the data lives" className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    {SYSTEMS.map(s => {
                        const on = s.value === draft.system
                        return (
                            <button key={s.value} type="button" role="radio" aria-checked={on}
                                onClick={() => onChange({ system: s.value })}
                                className={cn(
                                    'group flex items-center gap-3 rounded-2xl border-2 p-3 text-left transition-all duration-150',
                                    on ? cn(s.ring, 'shadow-md')
                                        : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-black/[0.18] dark:hover:border-white/[0.20] hover:-translate-y-0.5',
                                )}>
                                <SystemTile system={s.value} />
                                <span className="min-w-0">
                                    <span className="block text-sm font-semibold text-ink">{s.label}</span>
                                    <span className="block text-[11px] leading-snug text-ink-muted">{s.detail}</span>
                                </span>
                            </button>
                        )
                    })}
                </div>
            </StepBlock>
            <StepBlock delay={0.08}>
                <FieldLabel required hint={`${length} / ${TITLE_MAX}`}>A short name for it</FieldLabel>
                <BigInput aria-label="A short name for it" value={draft.title} onChange={e => onChange({ title: e.target.value })}
                    placeholder={`e.g. ${chosen?.titleExample ?? 'Finance marts'}`} maxLength={TITLE_MAX}
                    state={length > 0 ? 'valid' : 'idle'} />
                <Hint>How you and the platform team will refer to this request.</Hint>
            </StepBlock>
            <StepBlock delay={0.12}>
                <FieldLabel hint="optional">What exactly?</FieldLabel>
                <BigTextarea rows={3} aria-label="What exactly?" value={draft.details ?? ''} onChange={e => onChange({ details: e.target.value })}
                    placeholder={chosen?.detailsPlaceholder ?? 'Schemas, tables, projects or files — whatever you know.'}
                    maxLength={2000} className="font-sans" />
                <Hint>{chosen?.hint ?? 'Schemas, tables, projects or files — whatever you know. The platform team will fill in the rest.'}</Hint>
            </StepBlock>
        </StepColumn>
    )
}

// ── 2. Why & when ───────────────────────────────────────────────────────
export function WhyStep({ draft, onChange, contacts, onAddContact, onRemoveContact, meId }: {
    draft: AskDraft
    onChange: Patch
    contacts: PersonChip[]
    onAddContact: (p: PersonChip) => void
    onRemoveContact: (id: string) => void
    meId?: string
}) {
    return (
        <StepColumn wide>
            <StepHero pill="Why & when" pillIcon={Target} title="What’s it for, and by when?"
                subtitle="A line on why helps the platform team connect the right thing first — and the people who know the data save everyone time." />
            <StepBlock delay={0.04}>
                <FieldLabel hint="optional">What will you use it for?</FieldLabel>
                <BigTextarea rows={3} aria-label="What will you use it for?" value={draft.purpose ?? ''} onChange={e => onChange({ purpose: e.target.value })}
                    placeholder="e.g. Trace the month-end figures back to the ledger for the audit in March."
                    maxLength={2000} className="font-sans" />
            </StepBlock>
            <StepBlock delay={0.08}>
                <FieldLabel>How soon?</FieldLabel>
                <div role="radiogroup" aria-label="How soon" className="grid grid-cols-3 gap-2.5">
                    {URGENCIES.map(u => {
                        const on = u.value === draft.urgency
                        return (
                            <button key={u.value} type="button" role="radio" aria-checked={on} onClick={() => onChange({ urgency: u.value })}
                                className={cn('flex flex-col items-center gap-1 rounded-2xl border-2 px-3 py-3 text-center transition-colors duration-150',
                                    on ? 'border-indigo-500 bg-indigo-500/[0.07]' : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-indigo-500/40')}>
                                <u.icon className={cn('h-4 w-4', on ? 'text-indigo-500' : 'text-ink-muted')} aria-hidden />
                                <span className={cn('text-sm font-semibold', on ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink')}>{u.label}</span>
                                <span className="text-[10px] text-ink-muted">{u.detail}</span>
                            </button>
                        )
                    })}
                </div>
            </StepBlock>
            <StepBlock delay={0.12} className="space-y-3">
                <FieldLabel hint="optional">People who know this data</FieldLabel>
                {contacts.length > 0 && (
                    <ul aria-label="People who know this data" className="space-y-2">
                        {contacts.map(c => (
                            <li key={c.id} className="flex items-center gap-3 rounded-2xl border border-glass-border bg-canvas-elevated px-3.5 py-2.5">
                                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/10 text-xs font-bold text-indigo-600 dark:text-indigo-300">
                                    {c.name.slice(0, 1).toUpperCase()}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium text-ink">{c.name}</span>
                                    {c.detail && <span className="block truncate text-[11px] text-ink-muted">{c.detail}</span>}
                                </span>
                                <button type="button" onClick={() => onRemoveContact(c.id)} aria-label={`Remove ${c.name}`}
                                    className="rounded-lg p-1 text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
                                    <X className="h-4 w-4" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <SubjectPicker
                    label="Add someone who knows it"
                    types={['user']}
                    exclude={[...contacts.map(c => subjectKey({ type: 'user', id: c.id })), ...(meId ? [subjectKey({ type: 'user', id: meId })] : [])]}
                    onPick={s => onAddContact({ id: s.id, name: s.name, detail: s.detail })}
                />
                <Hint>Its owner, or whoever looks after it. They aren’t added to the workspace — the platform team may ask them about access.</Hint>
            </StepBlock>
        </StepColumn>
    )
}

// ── 3. Review & send ────────────────────────────────────────────────────
export function ReviewStep({ draft, contacts, workspaceName }: { draft: AskDraft; contacts: PersonChip[]; workspaceName: string }) {
    const system = systemOf(draft.system ?? 'other')
    const urgency = urgencyOf(draft.urgency)
    return (
        <StepColumn wide>
            <StepHero pill="Review" pillIcon={Send} title="Ready to send?"
                subtitle="Here’s what the platform team will see. Go back to change anything." />
            <StepBlock delay={0.04}>
                <div className="overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated">
                    <div className="relative flex items-start gap-3 border-b border-glass-border p-4">
                        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-r from-indigo-500/[0.06] to-violet-500/[0.03]" />
                        <span className="relative"><SystemTile system={system.value} size="lg" /></span>
                        <span className="relative min-w-0">
                            <span className="block truncate font-display text-lg font-bold text-ink">{draft.title.trim() || 'Untitled'}</span>
                            <span className="block text-xs text-ink-muted">From {system.label} · for {workspaceName}</span>
                        </span>
                    </div>
                    <dl className="divide-y divide-glass-border text-sm">
                        <Row icon={Search} label="What">{draft.details?.trim() || <span className="text-ink-muted">Not described — the platform team may ask.</span>}</Row>
                        <Row icon={MessageSquareText} label="Why">{draft.purpose?.trim() || <span className="text-ink-muted">Not given</span>}</Row>
                        <Row icon={CalendarClock} label="When">{urgency.label} <span className="text-ink-muted">· {urgency.detail}</span></Row>
                        <Row icon={UserRound} label="Who knows it">
                            {contacts.length ? contacts.map(c => c.name).join(', ') : <span className="text-ink-muted">Nobody named</span>}
                        </Row>
                    </dl>
                </div>
            </StepBlock>
            <StepBlock delay={0.08}>
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4">
                    <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                        <Inbox className="h-3.5 w-3.5" aria-hidden /> What happens next
                    </p>
                    <DataRequestProgress status={null} />
                </div>
            </StepBlock>
        </StepColumn>
    )
}

function Row({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3">
            <dt className="flex w-32 shrink-0 items-center gap-2 text-xs font-semibold text-ink-muted">
                <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
            </dt>
            <dd className="min-w-0 flex-1 whitespace-pre-line text-ink">{children}</dd>
        </div>
    )
}
