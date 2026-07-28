/**
 * Step 1 — who the link is for.
 *
 * First because it is the only question whose answer constrains the
 * others, and because it is the one the inviter can already answer before
 * opening the wizard. Each card states the constraint it applies and the
 * limits choosing it will set: this is a safety decision, and defaults you
 * can see are defaults you can disagree with.
 */
import { motion } from 'framer-motion'
import {
    Mail, ListChecks, Building2, Globe, CheckCircle2, AlertCircle, UserPlus,
    Users, Clock, SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    StepColumn, StepHero, StepBlock, FieldLabel, BigInput, BigTextarea, Hint,
} from '../ui'
import type { Audience, InviteWizardState } from '../useInviteWizard'

const AUDIENCES: {
    value: Audience
    label: string
    hint: string
    icon: typeof Mail
    tone: string
    /** The two limits this choice starts with, in plain words.
     *
     *  These used to be one uppercase token — "1 SEAT · 7 DAYS" — which
     *  read as a property of the audience rather than an editable starting
     *  point, and did not say what a "seat" was. Split into labelled
     *  values with their own icons, under a rule, so the card separates
     *  what the choice IS from what it SETS. */
    seats: string
    life: string
}[] = [
    {
        value: 'person', label: 'One specific person', icon: Mail,
        hint: 'Pinned to their email address. Forwarding it achieves nothing.',
        tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
        seats: '1 person', life: '7 days',
    },
    {
        value: 'several', label: 'Several people', icon: ListChecks,
        hint: 'A separate pinned link each, revocable and traceable on its own.',
        tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
        seats: '1 each', life: '7 days',
    },
    {
        value: 'domain', label: 'Anyone at a domain', icon: Building2,
        hint: 'Only addresses at one domain — safe to post in a team channel.',
        tone: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/25',
        seats: 'Up to 25', life: '30 days',
    },
    {
        value: 'anyone', label: 'Anyone with the link', icon: Globe,
        hint: 'Forwardable to whoever ends up with the URL.',
        tone: 'text-amber-500 bg-amber-500/10 border-amber-500/25',
        seats: 'Up to 5', life: '7 days',
    },
]

export function AudienceStep({ w }: { w: InviteWizardState }) {
    return (
        <StepColumn wide>
            <StepHero
                pill="Start here"
                pillIcon={UserPlus}
                title="Who is this link for?"
                subtitle="This sets how tightly the link is bound, and picks limits to match. You can change any of them before you generate it."
            />

            <StepBlock delay={0.04}>
                {/* The limits on each card are a starting point, not a
                    property of the audience. Saying so once here beats
                    repeating it on four cards — or leaving it unsaid, which
                    is what made the row read as fixed. */}
                <p className="flex items-center justify-center gap-1.5 text-[11px] text-ink-muted mb-3">
                    <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                    Each choice sets limits that suit it. You can change them on the Safety step.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {AUDIENCES.map(a => {
                        const Icon = a.icon
                        const selected = w.audience === a.value
                        return (
                            <button
                                key={a.value}
                                type="button"
                                onClick={() => w.pickAudience(a.value)}
                                className={cn(
                                    'group relative flex flex-col gap-3 p-4 rounded-2xl border-2 text-left transition-colors duration-150',
                                    selected
                                        ? 'border-indigo-500 bg-indigo-500/[0.07] shadow-sm'
                                        : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-indigo-500/40',
                                )}
                            >
                                <div className="flex items-start gap-3">
                                    <span className={cn(
                                        'w-11 h-11 rounded-xl border flex items-center justify-center shrink-0 transition-transform duration-150 group-hover:scale-105',
                                        a.tone,
                                    )}>
                                        <Icon className="w-5 h-5" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-1.5">
                                            <span className={cn(
                                                'text-sm font-semibold',
                                                selected ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink',
                                            )}>
                                                {a.label}
                                            </span>
                                            {selected && <CheckCircle2 className="w-4 h-4 text-indigo-500 shrink-0" />}
                                        </span>
                                        <span className="text-xs text-ink-muted leading-relaxed block mt-1">
                                            {a.hint}
                                        </span>
                                    </span>
                                </div>
                                {/* What this choice SETS, under a rule that
                                    separates it from what the choice IS. */}
                                <span className={cn(
                                    'flex items-stretch gap-3 pt-3 border-t',
                                    selected
                                        ? 'border-indigo-500/20'
                                        : 'border-black/[0.07] dark:border-white/[0.09]',
                                )}>
                                    {([
                                        { icon: Users, label: 'Who can use it', value: a.seats },
                                        { icon: Clock, label: 'Stays live for', value: a.life },
                                    ] as const).map(m => {
                                        const MetaIcon = m.icon
                                        return (
                                            <span key={m.label} className="flex-1 min-w-0">
                                                <span className="flex items-center gap-1 text-ink-muted">
                                                    <MetaIcon className="w-3 h-3 shrink-0" />
                                                    <span className="text-[10px] font-medium truncate">
                                                        {m.label}
                                                    </span>
                                                </span>
                                                <span className={cn(
                                                    'block text-xs font-semibold mt-0.5 truncate',
                                                    selected ? 'text-indigo-600 dark:text-indigo-400' : 'text-ink',
                                                )}>
                                                    {m.value}
                                                </span>
                                            </span>
                                        )
                                    })}
                                </span>
                            </button>
                        )
                    })}
                </div>
            </StepBlock>

            {/* The chosen audience's own field. A recipient box with no
                audience picked is a question without a subject. Keyed enter
                animation, deliberately not an AnimatePresence — switching
                audience should swap the field at once rather than briefly
                show a domain box for a link pinned to a person. */}
            {w.audience && (
                <motion.div
                    key={w.audience}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.15 }}
                >
                    {w.audience === 'person' && (
                        <>
                            <FieldLabel required>Their email address</FieldLabel>
                            <BigInput
                                type="email"
                                icon={Mail}
                                value={w.email}
                                onChange={e => w.setEmail(e.target.value)}
                                placeholder="user@company.com"
                                state={!w.email.trim() ? 'idle' : w.emailValid ? 'valid' : 'invalid'}
                            />
                            <Hint>
                                The link refuses any signup whose email doesn&apos;t match.
                            </Hint>
                        </>
                    )}

                    {w.audience === 'several' && (
                        <>
                            <FieldLabel required hint="one per line, or comma separated">
                                Their email addresses
                            </FieldLabel>
                            <BigTextarea
                                value={w.bulkEmails}
                                onChange={e => w.setBulkEmails(e.target.value)}
                                rows={5}
                                placeholder={'alice@company.com\nbob@company.com'}
                            />
                            <Hint>
                                {w.bulkEmailList.length > 0
                                    ? `${w.bulkEmailList.length} ${w.bulkEmailList.length === 1 ? 'address' : 'addresses'} — one pinned link each, so every invitation can be revoked and traced on its own.`
                                    : 'Paste a column from a spreadsheet, or type them out.'}
                            </Hint>
                        </>
                    )}

                    {w.audience === 'domain' && (
                        <>
                            <FieldLabel required>Their email domain</FieldLabel>
                            <BigInput
                                type="text"
                                icon={Building2}
                                value={w.emailDomain}
                                onChange={e => w.setEmailDomain(e.target.value)}
                                placeholder="company.com"
                                state={!w.emailDomain.trim() ? 'idle' : w.domainValid ? 'valid' : 'invalid'}
                            />
                            <Hint>
                                {w.domainValid
                                    ? `Only @${w.emailDomain.trim().replace(/^@/, '')} addresses can use this link.`
                                    : 'The middle ground between anyone-with-the-link and pinning one address.'}
                            </Hint>
                        </>
                    )}

                    {w.audience === 'anyone' && (
                        <div className="flex items-start gap-3 p-4 rounded-2xl bg-amber-500/[0.08] border-2 border-amber-500/25 text-amber-700 dark:text-amber-300">
                            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                            <div className="text-sm leading-relaxed">
                                <p className="font-semibold">Anyone who ends up with the URL can use it.</p>
                                <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-300/80">
                                    It has been capped at 5 people for 7 days to bound that. Both are
                                    adjustable two steps from here, and the link can be revoked at any
                                    time from Manage links.
                                </p>
                            </div>
                        </div>
                    )}
                </motion.div>
            )}
        </StepColumn>
    )
}
