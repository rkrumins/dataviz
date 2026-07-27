/**
 * Step 1 — who the link is for.
 *
 * First because it is the only question whose answer constrains the
 * others, and because it is the one the inviter can already answer before
 * opening the wizard. Each card states the constraint it applies, not just
 * its name: this is a safety decision and should read like one.
 */
import { motion } from 'framer-motion'
import { Mail, ListChecks, Building2, Globe, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SectionLabel, FieldWithIcon, FieldHint } from '../pickers'
import { INPUT_CLASS } from '../roleModel'
import type { Audience, InviteWizardState } from '../useInviteWizard'

const AUDIENCES: {
    value: Audience
    label: string
    hint: string
    icon: typeof Mail
    tone: string
    defaults: string
}[] = [
    {
        value: 'person', label: 'One specific person', icon: Mail,
        hint: 'Pinned to their email address. Nobody else can use it, so forwarding it achieves nothing.',
        tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
        defaults: '1 seat · 7 days',
    },
    {
        value: 'several', label: 'Several people', icon: ListChecks,
        hint: 'A separate pinned link each, so every invitation can be revoked and traced on its own.',
        tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
        defaults: 'one link each · 7 days',
    },
    {
        value: 'domain', label: 'Anyone at a domain', icon: Building2,
        hint: 'Only addresses at one domain can redeem it — safe to post in a team channel.',
        tone: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/25',
        defaults: '25 seats · 30 days',
    },
    {
        value: 'anyone', label: 'Anyone with the link', icon: Globe,
        hint: 'Forwardable to anyone who ends up with the URL. Arrives capped and short-lived.',
        tone: 'text-amber-500 bg-amber-500/10 border-amber-500/25',
        defaults: '5 seats · 7 days',
    },
]

export function AudienceStep({ w }: { w: InviteWizardState }) {
    return (
        <div>
            <h3 className="text-lg font-bold text-ink">Who is this link for?</h3>
            <p className="text-sm text-ink-muted mt-1 mb-5 leading-relaxed">
                This sets how tightly the link is bound, and picks sensible limits to
                match. You can change any of them before you generate it.
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
                                'group relative flex flex-col gap-2.5 p-4 rounded-xl border-2 text-left transition-all duration-150',
                                selected
                                    ? 'border-indigo-500 bg-indigo-500/[0.07] shadow-sm'
                                    : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-indigo-500/40 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                            )}
                        >
                            <div className="flex items-start gap-3">
                                <span className={cn(
                                    'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0 transition-transform group-hover:scale-105',
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
                                    <span className="text-[11px] text-ink-muted leading-relaxed block mt-1">
                                        {a.hint}
                                    </span>
                                </span>
                            </div>
                            {/* What choosing this will set. Defaults you can see
                                are defaults you can disagree with. */}
                            <span className={cn(
                                'text-[10px] font-semibold uppercase tracking-wider self-start px-2 py-0.5 rounded-md',
                                selected
                                    ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
                                    : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
                            )}>
                                {a.defaults}
                            </span>
                        </button>
                    )
                })}
            </div>

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
                    className="mt-6"
                >
                    {w.audience === 'person' && (
                        <>
                            <SectionLabel>Their email address</SectionLabel>
                            <FieldWithIcon icon={Mail} className="max-w-md">
                                <input
                                    type="email"
                                    value={w.email}
                                    onChange={e => w.setEmail(e.target.value)}
                                    placeholder="user@company.com"
                                    className={INPUT_CLASS}
                                />
                            </FieldWithIcon>
                            <FieldHint>
                                The link refuses any signup whose email doesn&apos;t match.
                            </FieldHint>
                        </>
                    )}

                    {w.audience === 'several' && (
                        <>
                            <SectionLabel>Their email addresses</SectionLabel>
                            <textarea
                                value={w.bulkEmails}
                                onChange={e => w.setBulkEmails(e.target.value)}
                                rows={5}
                                placeholder={'alice@company.com\nbob@company.com'}
                                className="w-full bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] focus:border-indigo-500/50 rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:outline-none transition-colors font-mono"
                            />
                            <FieldHint>
                                {w.bulkEmailList.length > 0
                                    ? `${w.bulkEmailList.length} ${w.bulkEmailList.length === 1 ? 'address' : 'addresses'} — one pinned link each, so every invitation can be revoked and traced on its own.`
                                    : 'One address per line, or separated by commas.'}
                            </FieldHint>
                        </>
                    )}

                    {w.audience === 'domain' && (
                        <>
                            <SectionLabel>Their email domain</SectionLabel>
                            <FieldWithIcon icon={Building2} className="max-w-xs">
                                <input
                                    type="text"
                                    value={w.emailDomain}
                                    onChange={e => w.setEmailDomain(e.target.value)}
                                    placeholder="company.com"
                                    className={INPUT_CLASS}
                                />
                            </FieldWithIcon>
                            <FieldHint>
                                {w.domainValid
                                    ? `Only @${w.emailDomain.trim().replace(/^@/, '')} addresses can use this link.`
                                    : 'The middle ground between anyone-with-the-link and pinning one address.'}
                            </FieldHint>
                        </>
                    )}

                    {w.audience === 'anyone' && (
                        <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/[0.08] border border-amber-500/25 text-amber-700 dark:text-amber-300">
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                            <div className="text-xs leading-relaxed">
                                <p className="font-semibold">Anyone who ends up with the URL can use it.</p>
                                <p className="mt-1 text-amber-700/80 dark:text-amber-300/80">
                                    It has been capped at 5 people for 7 days to bound that. Both are
                                    adjustable on the next-but-one step, and you can revoke the link at
                                    any time from Manage links.
                                </p>
                            </div>
                        </div>
                    )}
                </motion.div>
            )}
        </div>
    )
}
