/**
 * The accounts exist.
 *
 * The setup links are the only thing here that cannot be recovered
 * afterwards — a reset token is shown once and never again — so they are
 * the hero, with copy-all for a batch. Everything else on this screen is
 * confirmation; the links are the deliverable.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Copy, UserPlus, AlertCircle, ShieldCheck, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CreatedUser, BulkCreateUsersResponse } from '@/services/adminUserService'

const OUTCOME_COPY: Record<string, { label: string; tone: string }> = {
    created: { label: 'Created', tone: 'text-emerald-600 dark:text-emerald-400' },
    already_a_user: { label: 'Already had an account', tone: 'text-ink-muted' },
    invalid_email: { label: 'Not a valid address', tone: 'text-amber-600 dark:text-amber-400' },
    duplicate: { label: 'Listed twice', tone: 'text-ink-muted' },
    failed: { label: 'Could not be created', tone: 'text-red-600 dark:text-red-400' },
}

function setupUrl(token: string): string {
    return `${window.location.origin}/reset-password?token=${token}`
}

function CopyButton({ text, label }: { text: string; label: string }) {
    const [done, setDone] = useState(false)
    return (
        <button
            onClick={async () => {
                await navigator.clipboard.writeText(text)
                setDone(true)
                setTimeout(() => setDone(false), 2000)
            }}
            className={cn(
                'shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors duration-150',
                done
                    ? 'bg-emerald-500 text-white'
                    : 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white hover:brightness-110 shadow-md',
            )}
        >
            {done ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {done ? 'Copied' : label}
        </button>
    )
}

export function UserSuccessPhase({
    result, bulkResult,
}: {
    result: CreatedUser | null
    bulkResult: BulkCreateUsersResponse | null
}) {
    const createdRows = bulkResult?.results.filter(r => r.outcome === 'created' && r.setupToken) ?? []
    const allLinks = createdRows
        .map(r => `${r.email}\t${setupUrl(r.setupToken as string)}`)
        .join('\n')

    return (
        <div className="relative flex flex-col items-center text-center px-2">
            <motion.div
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 18 }}
                className="relative"
            >
                <div aria-hidden className="absolute -inset-5 rounded-full bg-emerald-500/15 blur-2xl" />
                <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/25">
                    <UserPlus className="w-8 h-8 text-white" strokeWidth={2.5} />
                </div>
            </motion.div>

            <motion.h3
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08 }}
                className="mt-6 text-2xl font-bold text-ink"
            >
                {bulkResult
                    ? `${bulkResult.created} account${bulkResult.created === 1 ? '' : 's'} created`
                    : 'Account created'}
            </motion.h3>

            {result && (
                <motion.p
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.12 }}
                    className="mt-2 text-sm text-ink-muted"
                >
                    <span className="font-semibold text-ink">
                        {result.firstName} {result.lastName}
                    </span>
                    <span className="text-ink-muted"> · {result.email}</span>
                </motion.p>
            )}

            {/* Single: the one link, big. */}
            {result?.setupToken && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.16 }}
                    className="mt-6 w-full max-w-2xl"
                >
                    <p className="text-xs text-ink-muted mb-2 text-left">
                        Send them this to choose a password. It is shown once.
                    </p>
                    <div className="flex items-center gap-2 rounded-2xl border-2 border-emerald-500/40 bg-emerald-500/[0.05] p-2 pl-4">
                        <input
                            readOnly
                            value={setupUrl(result.setupToken)}
                            onFocus={e => e.currentTarget.select()}
                            aria-label="Setup link"
                            className="flex-1 min-w-0 bg-transparent font-mono text-xs sm:text-sm text-ink outline-none"
                        />
                        <CopyButton text={setupUrl(result.setupToken)} label="Copy link" />
                    </div>
                </motion.div>
            )}

            {/* Bulk: every row's outcome, and one copy for the whole batch. */}
            {bulkResult && (
                <motion.div
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.16 }}
                    className="mt-6 w-full max-w-2xl text-left"
                >
                    {createdRows.length > 0 && (
                        <div className="flex items-center justify-between gap-3 mb-3">
                            <p className="text-xs text-ink-muted">
                                Each link is shown once. Copy them somewhere before you close this.
                            </p>
                            <CopyButton text={allLinks} label={`Copy all ${createdRows.length}`} />
                        </div>
                    )}
                    <div className="rounded-2xl border-2 border-black/[0.10] dark:border-white/[0.12] overflow-hidden max-h-72 overflow-y-auto">
                        {bulkResult.results.map(r => {
                            const copy = OUTCOME_COPY[r.outcome] ?? OUTCOME_COPY.failed
                            const ok = r.outcome === 'created'
                            return (
                                <div
                                    key={r.email}
                                    className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.06] dark:border-white/[0.08] last:border-0"
                                >
                                    {ok
                                        ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                        : <AlertCircle className="w-4 h-4 text-ink-muted shrink-0" />}
                                    <span className="text-sm text-ink truncate flex-1 min-w-0">{r.email}</span>
                                    <span className={cn('text-[11px] font-semibold shrink-0', copy.tone)}>
                                        {copy.label}
                                    </span>
                                </div>
                            )
                        })}
                    </div>
                </motion.div>
            )}

            <motion.p
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ delay: 0.24 }}
                className="mt-7 inline-flex items-center gap-1.5 text-xs text-ink-muted"
            >
                <ShieldCheck className="w-3.5 h-3.5" />
                Everyone here is in the user list now, and can be suspended at any time
            </motion.p>
        </div>
    )
}
