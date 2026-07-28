/**
 * The link exists. Say so properly.
 *
 * Modelled on ViewWizard's CreationPhase: a spring-in success mark with a
 * glow behind it, the thing you made named underneath, its facts as tiles,
 * and then the one action that matters. The link itself is the hero — it
 * is the only artefact here that cannot be recovered from this screen once
 * it is closed, because the admin list deliberately never returns tokens.
 */
import { motion } from 'framer-motion'
import {
    Check, Copy, Mail, Clock, Users, Shield, Globe, Building2, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { roleVisualFor } from '@/lib/roleVisual'
import type { InviteResponse } from '@/services/adminUserService'

const CONFETTI = [
    { left: '12%', color: '#6366f1', delay: '0s', dx: '-16px', rot: '150deg' },
    { left: '24%', color: '#10b981', delay: '.05s', dx: '10px', rot: '-120deg' },
    { left: '38%', color: '#f59e0b', delay: '.12s', dx: '-8px', rot: '200deg' },
    { left: '52%', color: '#6366f1', delay: '.02s', dx: '14px', rot: '-90deg' },
    { left: '66%', color: '#10b981', delay: '.16s', dx: '-12px', rot: '170deg' },
    { left: '78%', color: '#8b5cf6', delay: '.09s', dx: '8px', rot: '-140deg' },
    { left: '88%', color: '#f59e0b', delay: '.2s', dx: '-6px', rot: '110deg' },
]

const CONFETTI_KEYFRAMES = `
@keyframes iw-confetti-fall {
  0%   { transform: translate3d(0,-12px,0) rotate(0deg); opacity: 0; }
  15%  { opacity: 1; }
  100% { transform: translate3d(var(--iw-dx,0), 190px, 0) rotate(var(--iw-rot,180deg)); opacity: 0; }
}
.iw-confetti-piece { animation: iw-confetti-fall 1.5s ease-in forwards; }
@media (prefers-reduced-motion: reduce) { .iw-confetti-piece { display: none; } }
`

function ConfettiBurst() {
    return (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-4 h-56 overflow-hidden">
            <style>{CONFETTI_KEYFRAMES}</style>
            {CONFETTI.map((p, i) => (
                <span
                    key={i}
                    className="iw-confetti-piece absolute top-0 block w-1.5 h-3 rounded-[1px]"
                    style={{
                        left: p.left,
                        backgroundColor: p.color,
                        animationDelay: p.delay,
                        ['--iw-dx' as string]: p.dx,
                        ['--iw-rot' as string]: p.rot,
                    }}
                />
            ))}
        </div>
    )
}

function Stat({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string }) {
    return (
        <div className="min-w-[130px] flex-1 basis-[130px] max-w-[210px] rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated px-4 py-3 text-left">
            <div className="flex items-center gap-1.5 text-ink-muted mb-1">
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="text-[10px] font-semibold uppercase tracking-wider truncate">
                    {label}
                </span>
            </div>
            <p className="text-sm font-bold text-ink leading-snug break-words">{value}</p>
        </div>
    )
}

export function SuccessPhase({
    result, inviteUrl, copied, onCopy, expiresLabel,
}: {
    result: InviteResponse
    inviteUrl: string
    copied: boolean
    onCopy: () => void
    /** The window the user picked, passed straight through rather than
     *  re-derived from the timestamp. Reading the clock during render is
     *  impure, and "30d" is what they chose — a computed "29d" a minute
     *  later would only look like a mistake. */
    expiresLabel: string
}) {
    const audience = result.email
        ? { icon: Mail, label: 'For', value: result.email }
        : result.emailDomain
            ? { icon: Building2, label: 'For', value: `@${result.emailDomain}` }
            : { icon: Globe, label: 'For', value: 'Anyone with the link' }

    return (
        <div className="relative flex flex-col items-center text-center px-2">
            <ConfettiBurst />

            <motion.div
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 18 }}
                className="relative"
            >
                <div aria-hidden className="absolute -inset-5 rounded-full bg-emerald-500/15 blur-2xl" />
                <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25">
                    <Check className="w-8 h-8 text-white" strokeWidth={3} />
                </div>
            </motion.div>

            <motion.h3
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08 }}
                className="mt-6 text-2xl font-bold text-ink"
            >
                Your invite link is ready
            </motion.h3>

            <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 }}
                className="mt-2 max-w-lg text-sm text-ink-muted leading-relaxed"
            >
                Send it however you like. This is the only time it is shown —
                the links list tracks it, but never shows the URL again.
            </motion.p>

            {/* The artefact. Big, monospaced, and copyable in one press. */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.16 }}
                className="mt-6 w-full max-w-2xl"
            >
                <div className={cn(
                    'flex items-center gap-2 rounded-2xl border-2 p-2 pl-4 transition-colors duration-200',
                    copied
                        ? 'border-emerald-400 dark:border-emerald-500/60 bg-emerald-500/[0.06]'
                        : 'border-indigo-500/40 bg-indigo-500/[0.05]',
                )}>
                    <input
                        readOnly
                        value={inviteUrl}
                        onFocus={e => e.currentTarget.select()}
                        aria-label="Invite link"
                        className="flex-1 min-w-0 bg-transparent font-mono text-xs sm:text-sm text-ink outline-none"
                    />
                    <button
                        onClick={onCopy}
                        className={cn(
                            'shrink-0 inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors duration-150',
                            copied
                                ? 'bg-emerald-500 text-white'
                                : 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md',
                        )}
                    >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copied ? 'Copied' : 'Copy link'}
                    </button>
                </div>
            </motion.div>

            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="mt-5 flex flex-wrap items-stretch justify-center gap-3 w-full max-w-2xl"
            >
                <Stat icon={audience.icon} label={audience.label} value={audience.value} />
                <Stat
                    icon={Shield}
                    label="Grants"
                    value={result.role ? roleVisualFor(result.role).label : 'Account only'}
                />
                <Stat
                    icon={Users}
                    label="Seats"
                    value={result.maxUses === null || result.maxUses === undefined
                        ? 'Unlimited'
                        : `${result.maxUses}`}
                />
                <Stat icon={Clock} label="Expires in" value={expiresLabel} />
            </motion.div>

            <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="mt-7 inline-flex items-center gap-1.5 text-xs text-ink-muted"
            >
                <ShieldCheck className="w-3.5 h-3.5" />
                Revocable at any time from Manage links
            </motion.p>
        </div>
    )
}
