/**
 * One person, as the answer to "can they sign in, and how?"
 *
 * The list this replaces printed the raw shape: `usr_7f71… · active`,
 * `local_signup`, `sso_jit` — our enum values, unexplained. Those strings
 * do carry the answer, but only to someone who already knows the schema,
 * and the person reading this screen is mid-incident.
 *
 * So the card leads with how this account can be signed into, because that
 * is what the investigation is about. `matchedOn` is surfaced properly too:
 * knowing a person was found by their staff number rather than their email
 * tells you which of your assumptions was wrong.
 */
import { motion } from 'framer-motion'
import { KeyRound, Link2, Mail, ShieldCheck, Tag } from 'lucide-react'

import type { UserSummary } from '@/services/ssoAdminService'
import { cn } from '@/lib/utils'

/** Our enum, in words. An operator should not have to know `sso_jit`. */
const ORIGIN: Record<string, string> = {
    local_signup: 'Signed up with a password',
    sso_jit: 'Created automatically on first SSO sign-in',
    invite: 'Accepted an invite',
    admin_created: 'Created by an administrator',
    admin_linked: 'Linked by an administrator',
}

const STATUS_TONE: Record<string, string> = {
    active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    pending: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    suspended: 'bg-red-500/15 text-red-600 dark:text-red-400',
}

export function UserResultCard({
    user, index,
}: {
    user: UserSummary
    index: number
}) {
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ')
    const ways = user.identities.length + (user.passwordSet ? 1 : 0)

    return (
        <motion.li
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.16, delay: Math.min(index, 5) * 0.04 }}
            className="rounded-2xl border-2 border-black/[0.08] dark:border-white/[0.10] overflow-hidden"
        >
            <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-ink truncate">
                                {name || user.email}
                            </span>
                            <span className={cn(
                                'px-1.5 py-0.5 rounded text-[10px] font-semibold',
                                STATUS_TONE[user.status]
                                    ?? 'bg-black/[0.06] dark:bg-white/[0.10] text-ink-muted',
                            )}>
                                {user.status}
                            </span>
                        </div>
                        <p className="mt-0.5 text-xs text-ink-muted truncate">
                            {user.email}
                        </p>
                    </div>
                    <span className="shrink-0 text-[10px] text-ink-muted text-right">
                        {ORIGIN[user.signupSource] ?? user.signupSource}
                        {user.signupProvider && (
                            <span className="block opacity-70">
                                via {user.signupProvider.displayName}
                            </span>
                        )}
                    </span>
                </div>

                {/* Why this person came back for the query typed. When the
                    answer is "their staff number", that IS the finding. */}
                {user.matchedOn?.length ? (
                    <p className="mt-2 inline-flex items-center gap-1 text-[10px] text-ink-muted">
                        <Tag className="w-2.5 h-2.5" />
                        matched on {user.matchedOn.join(', ')}
                    </p>
                ) : null}
            </div>

            {/* The investigation's actual subject. */}
            <div className="px-4 py-3 border-t border-black/[0.06] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02]">
                <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                    Ways in ({ways})
                </h4>
                {ways === 0 ? (
                    <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                        None. No password and no linked identity — this account
                        cannot be signed into at all.
                    </p>
                ) : (
                    <ul className="mt-1.5 space-y-1">
                        {user.passwordSet && (
                            <li className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
                                <KeyRound className="w-3 h-3 shrink-0 text-ink-muted" />
                                Password
                            </li>
                        )}
                        {user.identities.map(i => (
                            <li key={i.id} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
                                <Link2 className="w-3 h-3 shrink-0 text-ink-muted" />
                                <span className="font-medium">
                                    {i.provider.displayName || i.provider.slug}
                                </span>
                                <span className="font-mono text-ink-muted truncate">
                                    {i.externalId}
                                </span>
                                {i.lastLoginAt && (
                                    <span className="text-ink-muted shrink-0">
                                        · last used {new Date(i.lastLoginAt).toLocaleDateString()}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {user.attributes.length > 0 && (
                <div className="px-4 py-3 border-t border-black/[0.06] dark:border-white/[0.08]">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                        Claim attributes
                    </h4>
                    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                        {user.attributes.map(a => (
                            <div key={a.key} className="contents">
                                <dt className="font-mono text-[11px] text-ink-muted">
                                    {a.key}
                                </dt>
                                <dd className="font-mono text-[11px] text-ink truncate">
                                    {a.value}
                                    {a.sourceProvider && (
                                        <span className="ml-1.5 text-ink-muted not-italic">
                                            from {a.sourceProvider.slug}
                                        </span>
                                    )}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            )}
        </motion.li>
    )
}

export { Mail, ShieldCheck }
