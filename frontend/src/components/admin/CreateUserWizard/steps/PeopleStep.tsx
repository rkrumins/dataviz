/**
 * Step 1 — who is being added.
 *
 * One person or a pasted list, because those are two genuinely different
 * jobs: typing out a new starter's name, versus onboarding a cohort from
 * a column somebody sent you.
 */
import { motion } from 'framer-motion'
import { Mail, User, ClipboardList, UserPlus, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StepColumn, StepHero, StepBlock, FieldLabel, BigInput, BigTextarea, Hint } from '@/components/admin/InviteWizard/ui'
import { deriveName, type CreateUserState, type Mode } from '../useCreateUser'

const MODES: { value: Mode; label: string; hint: string; icon: typeof User }[] = [
    {
        value: 'one', label: 'One person', icon: User,
        hint: 'Type their name and address. Best when you know exactly who is joining.',
    },
    {
        value: 'many', label: 'A list of people', icon: ClipboardList,
        hint: 'Paste addresses from a spreadsheet or an email. Names are filled in for you.',
    },
]

export function PeopleStep({ w }: { w: CreateUserState }) {
    return (
        <StepColumn>
            <StepHero
                pill="Start here"
                pillIcon={UserPlus}
                tone="emerald"
                title="Who are you adding?"
                subtitle="These accounts are created straight away — nobody has to accept anything first."
            />

            <StepBlock delay={0.04}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {MODES.map(m => {
                        const Icon = m.icon
                        const on = w.mode === m.value
                        return (
                            <button
                                key={m.value}
                                type="button"
                                onClick={() => w.setMode(m.value)}
                                className={cn(
                                    'flex items-start gap-3 p-4 rounded-2xl border-2 text-left transition-colors duration-150',
                                    on
                                        ? 'border-emerald-500 bg-emerald-500/[0.07] shadow-sm'
                                        : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-emerald-500/40',
                                )}
                            >
                                <span className={cn(
                                    'w-11 h-11 rounded-xl border flex items-center justify-center shrink-0',
                                    on
                                        ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-500'
                                        : 'bg-black/[0.03] dark:bg-white/[0.05] border-black/[0.07] dark:border-white/[0.09] text-ink-muted',
                                )}>
                                    <Icon className="w-5 h-5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                        <span className={cn(
                                            'text-sm font-semibold',
                                            on ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink',
                                        )}>{m.label}</span>
                                        {on && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                                    </span>
                                    <span className="text-xs text-ink-muted leading-relaxed block mt-1">
                                        {m.hint}
                                    </span>
                                </span>
                            </button>
                        )
                    })}
                </div>
            </StepBlock>

            <motion.div
                key={w.mode}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.15 }}
            >
                {w.mode === 'one' ? (
                    <div className="space-y-5">
                        <div>
                            <FieldLabel required>Email address</FieldLabel>
                            <BigInput
                                type="email"
                                icon={Mail}
                                value={w.email}
                                onChange={e => w.setEmail(e.target.value)}
                                placeholder="grace@company.com"
                                state={!w.email.trim() ? 'idle' : w.emailValid ? 'valid' : 'invalid'}
                            />
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                                <FieldLabel required>First name</FieldLabel>
                                <BigInput
                                    value={w.firstName}
                                    onChange={e => w.setFirstName(e.target.value)}
                                    placeholder="Grace"
                                />
                            </div>
                            <div>
                                <FieldLabel>Last name</FieldLabel>
                                <BigInput
                                    value={w.lastName}
                                    onChange={e => w.setLastName(e.target.value)}
                                    placeholder="Hopper"
                                />
                            </div>
                        </div>
                        {/* Offer the derived name rather than making them type
                            what the address already says. */}
                        {w.emailValid && !w.firstName.trim() && (
                            <button
                                type="button"
                                onClick={() => {
                                    const d = deriveName(w.email.trim())
                                    w.setFirstName(d.first)
                                    if (!w.lastName.trim()) w.setLastName(d.last)
                                }}
                                className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
                            >
                                Use “{`${deriveName(w.email.trim()).first} ${deriveName(w.email.trim()).last}`.trim()}” from the address
                            </button>
                        )}
                    </div>
                ) : (
                    <div>
                        <FieldLabel required hint="one per line — “Name &lt;a@b.com&gt;” works too">
                            Their email addresses
                        </FieldLabel>
                        <BigTextarea
                            value={w.bulkText}
                            onChange={e => w.setBulkText(e.target.value)}
                            rows={7}
                            placeholder={'grace.hopper@company.com\nAda Lovelace <ada@company.com>'}
                        />
                        {w.invalidBulk.length > 0 ? (
                            <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 mt-2 leading-relaxed">
                                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <span>
                                    {w.validBulk.length} will be created; {w.invalidBulk.length}{' '}
                                    {w.invalidBulk.length === 1 ? 'line is' : 'lines are'} not a valid
                                    address and will be skipped.
                                </span>
                            </p>
                        ) : (
                            <Hint>
                                {w.validBulk.length > 0
                                    ? `${w.validBulk.length} ${w.validBulk.length === 1 ? 'account' : 'accounts'} — names are taken from each address where you have not given one.`
                                    : 'Paste a column from a spreadsheet, or type them out.'}
                            </Hint>
                        )}
                    </div>
                )}
            </motion.div>
        </StepColumn>
    )
}
