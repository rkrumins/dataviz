/**
 * Step 3 — how they first get in.
 *
 * The most consequential choice in this wizard, and the one an admin is
 * least likely to have thought about, so each option states its own
 * trade-off rather than just its name. The default leaves nobody —
 * including the admin who created the account — knowing the password.
 */
import { motion } from 'framer-motion'
import { LinkIcon, KeyRound, Building2, CheckCircle2, ShieldCheck, Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { StepColumn, StepHero, StepBlock, FieldLabel, BigInput, Hint } from '@/components/admin/InviteWizard/ui'
import type { CredentialMode } from '@/services/adminUserService'
import type { CreateUserState } from '../useCreateUser'

const OPTIONS: Record<CredentialMode, {
    label: string
    hint: string
    icon: typeof LinkIcon
    tone: string
}> = {
    setup_link: {
        label: 'Send them a setup link',
        hint: 'The account has no password until they choose one. Nobody else ever knows it — including you.',
        icon: LinkIcon,
        tone: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
    },
    password: {
        label: 'Set a password yourself',
        hint: 'You pick it and pass it on. Quick, but you will know their password and nothing sends it for you.',
        icon: KeyRound,
        tone: 'text-amber-500 bg-amber-500/10 border-amber-500/25',
    },
    sso_only: {
        label: 'Single sign-on only',
        hint: 'No password at all. They sign in through your identity provider.',
        icon: Building2,
        tone: 'text-indigo-500 bg-indigo-500/10 border-indigo-500/25',
    },
}

export function SignInStep({ w }: { w: CreateUserState }) {
    const [reveal, setReveal] = useState(false)

    return (
        <StepColumn>
            <StepHero
                pill="Sign-in"
                pillIcon={ShieldCheck}
                tone="emerald"
                title="How will they get in?"
                subtitle="However you choose, the account exists the moment you finish — this only decides what they use to sign in with."
            />

            <StepBlock delay={0.04}>
                <div className="space-y-3">
                    {w.credentialOptions.map(mode => {
                        const o = OPTIONS[mode]
                        const Icon = o.icon
                        const on = w.credential === mode
                        return (
                            <button
                                key={mode}
                                type="button"
                                onClick={() => w.setCredential(mode)}
                                className={cn(
                                    'w-full flex items-start gap-3 p-4 rounded-2xl border-2 text-left transition-colors duration-150',
                                    on
                                        ? 'border-emerald-500 bg-emerald-500/[0.07] shadow-sm'
                                        : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-emerald-500/40',
                                )}
                            >
                                <span className={cn(
                                    'w-11 h-11 rounded-xl border flex items-center justify-center shrink-0',
                                    o.tone,
                                )}>
                                    <Icon className="w-5 h-5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-center gap-1.5">
                                        <span className={cn(
                                            'text-sm font-semibold',
                                            on ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink',
                                        )}>{o.label}</span>
                                        {on && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                                    </span>
                                    <span className="text-xs text-ink-muted leading-relaxed block mt-1">
                                        {o.hint}
                                    </span>
                                </span>
                            </button>
                        )
                    })}
                </div>
            </StepBlock>

            {w.credential === 'password' && (
                <motion.div
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.15 }}
                >
                    <FieldLabel required>Their password</FieldLabel>
                    <div className="relative">
                        <BigInput
                            type={reveal ? 'text' : 'password'}
                            value={w.password}
                            onChange={e => w.setPassword(e.target.value)}
                            placeholder="At least 12 characters"
                            state={!w.password ? 'idle' : w.passwordLongEnough ? 'valid' : 'invalid'}
                        />
                        {/* Revealed on demand: an admin typing a password for
                            somebody else needs to read it back to pass it on. */}
                        <button
                            type="button"
                            onClick={() => setReveal(r => !r)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            aria-label={reveal ? 'Hide password' : 'Show password'}
                        >
                            {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>
                    <Hint tone={w.password && !w.passwordLongEnough ? 'warn' : undefined}>
                        {w.password && !w.passwordLongEnough
                            ? 'Too short — the server applies the same rule it does to a password somebody picks for themselves.'
                            : 'You will need to pass this on yourself. Nothing emails it.'}
                    </Hint>
                </motion.div>
            )}

            <StepBlock delay={0.08}>
                <label className="flex items-start gap-3 p-4 rounded-2xl border-2 border-black/[0.10] dark:border-white/[0.12] cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={w.activate}
                        onChange={e => w.setActivate(e.target.checked)}
                        className="mt-0.5 accent-emerald-500 cursor-pointer w-4 h-4"
                    />
                    <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-ink">
                            Active straight away
                        </span>
                        <span className="block text-xs text-ink-muted leading-relaxed mt-0.5">
                            An account you typed out by hand has already been approved by the
                            act of typing it. Untick to park it in the pending queue instead.
                        </span>
                    </span>
                </label>
            </StepBlock>
        </StepColumn>
    )
}
