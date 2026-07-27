/**
 * What the wizard shows once the link (or links) exist.
 *
 * Moved out of AdminUsers.tsx with the rest of the invite flow.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import {
    Check, Copy, Mail, Shield, Clock, Building2, Sparkles,
    CheckCircle2, Users2, AtSign, Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { roleVisualFor } from '@/lib/roleVisual'
import { type BulkInviteResponse, type InviteResponse } from '@/services/adminUserService'

export function BulkInviteResultList({
    result, onAnother, onClose,
}: {
    result: BulkInviteResponse
    onAnother: () => void
    onClose: () => void
}) {
    const [copiedAll, setCopiedAll] = useState(false)
    const [copiedOne, setCopiedOne] = useState<string | null>(null)

    const urlFor = (token: string) => `${window.location.origin}/signup?invite=${token}`
    const created = result.results.filter(r => r.outcome === 'created')
    const skipped = result.results.filter(r => r.outcome !== 'created')

    const OUTCOME_COPY: Record<string, string> = {
        already_a_user: 'Already has an account',
        invalid_email: 'Not a valid address',
        duplicate: 'Listed more than once',
        failed: 'Could not be created',
    }

    return (
        <div className="p-6 space-y-4">
            <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
                <p className="text-sm font-semibold text-ink">
                    {result.created} {result.created === 1 ? 'link' : 'links'} created
                    {result.skipped > 0 && (
                        <span className="text-ink-muted font-normal">
                            {' '}· {result.skipped} skipped
                        </span>
                    )}
                </p>
            </div>

            {created.length > 0 && (
                <>
                    <button
                        onClick={async () => {
                            await navigator.clipboard.writeText(
                                created.map(r => `${r.email}\t${urlFor(r.inviteToken!)}`).join('\n'),
                            )
                            setCopiedAll(true)
                            setTimeout(() => setCopiedAll(false), 2000)
                        }}
                        className="w-full h-10 rounded-xl bg-accent-lineage text-white text-sm font-semibold hover:brightness-110 transition-all flex items-center justify-center gap-2"
                    >
                        {copiedAll ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copiedAll ? 'Copied' : 'Copy all as email + link'}
                    </button>

                    <ul className="space-y-1.5 max-h-64 overflow-y-auto">
                        {created.map(r => (
                            <li
                                key={r.email}
                                className="flex items-center gap-2 text-xs bg-canvas-elevated border border-glass-border rounded-lg px-2.5 py-2"
                            >
                                <span className="text-ink font-medium truncate w-40 shrink-0">{r.email}</span>
                                <code className="flex-1 min-w-0 truncate text-ink-muted">
                                    {urlFor(r.inviteToken!)}
                                </code>
                                <button
                                    onClick={async () => {
                                        await navigator.clipboard.writeText(urlFor(r.inviteToken!))
                                        setCopiedOne(r.email)
                                        setTimeout(() => setCopiedOne(null), 2000)
                                    }}
                                    className="p-1 rounded text-ink-muted hover:text-ink shrink-0"
                                    title={`Copy ${r.email}'s link`}
                                >
                                    {copiedOne === r.email
                                        ? <Check className="w-3.5 h-3.5 text-emerald-500" />
                                        : <Copy className="w-3.5 h-3.5" />}
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            )}

            {skipped.length > 0 && (
                <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-1.5">
                        Skipped
                    </p>
                    <ul className="space-y-1">
                        {skipped.map((r, i) => (
                            <li key={`${r.email}-${i}`} className="flex items-center justify-between text-xs">
                                <span className="text-ink-secondary truncate">{r.email}</span>
                                <span className="text-ink-muted shrink-0 ml-3">
                                    {OUTCOME_COPY[r.outcome] ?? r.detail}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
                <button
                    onClick={onAnother}
                    className="text-xs font-medium text-ink-secondary hover:text-ink transition-colors"
                >
                    Invite more people
                </button>
                <button
                    onClick={onClose}
                    className="px-4 py-2 rounded-xl text-sm font-medium text-ink border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                    Done
                </button>
            </div>
        </div>
    )
}


export function InviteSummary({
    roleLabel, workspaceName, groupNames, email, emailRequired, shareable, expiresIn,
    maxUses, emailDomain, recipientCount = 1,
}: {
    roleLabel: string | null
    workspaceName: string | null
    groupNames: string[]
    email: string | null
    emailRequired: boolean
    /** Phase 14: when true, the invite is explicitly a shareable
     *  group invite — the summary narrates that instead of
     *  "Shareable link (no email pin)." */
    shareable: boolean
    expiresIn: string
    /** Phase 15: the two limits. A summary that silently omitted them
     *  would be the least trustworthy part of the form — it is the one
     *  place claiming to describe the whole invite. */
    maxUses: number | null
    emailDomain: string | null
    /** Bulk mints one pinned link per address. Saying "usable once" about
     *  a batch of twelve describes one link and hides eleven. */
    recipientCount?: number
}) {
    // Build a tiny sentence: "Activate a new account, [grant Role in
    // Workspace], [add to groups X, Y]. [Email-bound to a@x.com] or
    // [Shareable]. Expires in 30d."
    const parts: string[] = ['Activate a new account']
    if (roleLabel) {
        if (workspaceName) {
            parts.push(`grant ${roleLabel} in ${workspaceName}`)
        } else {
            parts.push(`grant ${roleLabel}`)
        }
    }
    if (groupNames.length > 0) {
        parts.push(`add to ${groupNames.length === 1 ? 'group' : 'groups'} ${groupNames.join(', ')}`)
    }

    const recipient = recipientCount > 1
        ? `${recipientCount} separate links, each pinned to one address.`
        : email
        ? `Email-bound to ${email}.`
        : emailDomain
            // A domain restriction is the single most important thing to
            // surface about a shareable link — it is the difference between
            // "anyone with the URL" and "anyone at our company".
            ? `Anyone with an @${emailDomain} address can sign up.`
            : shareable
                ? 'Shareable group invite — anyone with the link can sign up.'
                : (emailRequired
                    ? 'Email required.'
                    : 'Shareable link (no email pin).')

    const seats = maxUses === null
        ? 'Usable any number of times'
        : `Usable ${maxUses === 1 ? 'once' : `${maxUses} times`}`

    return (
        <motion.div
            key={parts.join('|') + '|' + recipient + '|' + expiresIn + '|' + seats}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="p-4 rounded-2xl bg-gradient-to-br from-indigo-500/[0.10] via-indigo-500/[0.05] to-emerald-500/[0.06] border border-indigo-500/25"
        >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-accent-lineage mb-1.5">
                This invite will
            </p>
            <p className="text-xs text-ink leading-relaxed">
                {parts.join(', ')}.{' '}
                <span className={cn(emailRequired && !email && 'text-amber-600 dark:text-amber-400 font-medium')}>
                    {recipient}
                </span>
                {' '}<span className="font-semibold">{seats}</span>, expiring in{' '}
                <span className="font-semibold">{expiresIn}</span>.
            </p>
        </motion.div>
    )
}


// ── Phase 12: premium invite result card ─────────────────────────────
export function InviteResultCard({
    result, inviteUrl, copied, onCopy, onAnother, onClose,
}: {
    result: InviteResponse
    inviteUrl: string
    copied: boolean
    onCopy: () => void
    onAnother: () => void
    onClose: () => void
}) {
    const roleLabel = result.role
        ? roleVisualFor(result.role).label
        : 'No role (plain account)'
    const expiresWhen = (() => {
        const d = new Date(result.expiresAt)
        const diff = d.getTime() - Date.now()
        const days = Math.max(0, Math.floor(diff / 86_400_000))
        const hours = Math.max(0, Math.floor(diff / 3_600_000))
        return days >= 1 ? `${days}d` : `${hours}h`
    })()
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-4 mb-1"
        >
            {/* Hero */}
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-500/0 border border-emerald-500/20">
                <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
                    <Sparkles className="w-5 h-5 text-emerald-500" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-bold text-ink">Invite ready</p>
                    <p className="text-xs text-ink-muted">
                        Copy the link below and share it with the recipient.
                    </p>
                </div>
            </div>

            {/* Link card */}
            <div className="p-4 rounded-2xl bg-canvas-elevated border border-glass-border">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                    Invite link
                </p>
                <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-black/5 dark:bg-white/5 px-3 py-2.5 rounded-xl break-all text-ink select-all">
                        {inviteUrl}
                    </code>
                    <button onClick={onCopy}
                        className={cn(
                            "p-2.5 rounded-xl transition-colors shrink-0",
                            copied
                                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                : "bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/20",
                        )}
                        title={copied ? 'Copied' : 'Copy to clipboard'}
                    >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                </div>

                {/* Metadata grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
                    <MetaTile icon={Shield} label="Role" value={roleLabel} />
                    {result.workspaceId && (
                        <MetaTile icon={Building2} label="Workspace" value={result.workspaceId} />
                    )}
                    {result.groupIds && result.groupIds.length > 0 && (
                        <MetaTile
                            icon={Users2}
                            label={result.groupIds.length === 1 ? 'Group' : 'Groups'}
                            value={`${result.groupIds.length} attached`}
                        />
                    )}
                    <MetaTile icon={Clock} label="Expires in" value={expiresWhen} />
                    <MetaTile
                        icon={Users2}
                        label="Usable by"
                        value={
                            result.maxUses === null || result.maxUses === undefined
                                ? 'Unlimited people'
                                : result.maxUses === 1
                                    ? '1 person'
                                    : `Up to ${result.maxUses} people`
                        }
                        tone={result.maxUses ? 'slate' : 'amber'}
                    />
                    {result.email ? (
                        <MetaTile
                            icon={Lock}
                            label="Email-bound"
                            value={result.email}
                            tone="amber"
                        />
                    ) : result.emailDomain ? (
                        // Previously this said "Shareable link" regardless, so a
                        // domain-restricted invite was confirmed back as though it
                        // had no restriction at all — the one screen an admin
                        // checks before sending, disagreeing with what they set.
                        <MetaTile
                            icon={AtSign}
                            label="Restricted to"
                            value={`@${result.emailDomain}`}
                            tone="amber"
                        />
                    ) : (
                        <MetaTile
                            icon={Mail}
                            label="Recipient"
                            value="Anyone with the link"
                            tone="slate"
                        />
                    )}
                </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between gap-3">
                <button
                    onClick={onAnother}
                    className="text-xs font-semibold text-ink-muted hover:text-ink transition-colors"
                >
                    Generate another
                </button>
                <button
                    onClick={onClose}
                    className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-accent-lineage text-white hover:brightness-110 transition-colors duration-150 shadow-sm shadow-accent-lineage/20"
                >
                    Done
                </button>
            </div>
        </motion.div>
    )
}


function MetaTile({
    icon: Icon, label, value, tone = 'neutral',
}: {
    icon: typeof Shield
    label: string
    value: string
    tone?: 'neutral' | 'amber' | 'slate'
}) {
    const toneCls =
        tone === 'amber'
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20'
            : tone === 'slate'
                ? 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20'
                : 'bg-black/[0.03] dark:bg-white/[0.03] border-glass-border'
    return (
        <div className={cn('flex items-center gap-2.5 p-2.5 rounded-xl border', toneCls)}>
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider font-semibold opacity-70">
                    {label}
                </p>
                <p className="text-xs font-medium truncate">{value}</p>
            </div>
        </div>
    )
}

