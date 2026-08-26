/**
 * One connection, as a card.
 *
 * The table this replaces had seven columns — Slug, Display, Kind, Health,
 * Linking, Enabled, actions — which is a view of a database row. The
 * questions an operator actually arrives with are "is this thing working?"
 * and "can people use it yet?", and neither had a column.
 *
 * So the card leads with the states that answer them, and every state and
 * control explains itself in place: the status chip says draft / live /
 * off in words (a switched-off connection used to be 60% opacity under a
 * green "Live" chip — the card said the opposite of the stat tiles), the
 * enabled switch looks like a switch, and each glyph carries a real
 * tooltip (HoverTip) rather than the browser's one-second title chrome.
 */
import { motion } from 'framer-motion'
import {
    FlaskConical, Loader2, Pencil, Rocket, ShieldAlert, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { IdpProvider, IdpHealth } from '@/services/ssoAdminService'
import { AssurancePill } from '@/components/admin/AssurancePill'
import { HoverTip } from '@/components/ui/HoverTip'
import { timeAgo } from '@/lib/timeAgo'
import { logoFor } from './IdpLogos'
import { presetById } from './vendorPresets'

/** Which of this card's actions is in flight, so the control that is
 *  actually working can say so instead of every card greying out. */
export type CardPendingAction = 'toggle' | 'publish' | 'rehearse' | null

/** Draft vs live vs off, stated plainly — the single most important
 *  thing on the card. ``Off`` overrides ``Live``: a switched-off
 *  connection is NOT serving sign-ins, and saying "Live" while the
 *  stat tiles exclude it made the two surfaces contradict each other. */
function StatusChip({ provider }: { provider: IdpProvider }) {
    if (provider.lifecycle === 'draft') {
        const rehearsed = Boolean(provider.lastAssertionAt)
        return (
            <HoverTip label={rehearsed
                ? `Only administrators can see this connection. It has been rehearsed (last ${timeAgo(provider.lastAssertionAt as string)}), so publishing is the remaining step.`
                : 'Only administrators can see this connection. Rehearse it — sign in as yourself, nothing is written — before publishing.'}
            >
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-300 border border-amber-500/30">
                    Draft — not visible to anyone
                    {rehearsed && <span className="text-emerald-600 dark:text-emerald-300"> · rehearsed ✓</span>}
                </span>
            </HoverTip>
        )
    }
    if (!provider.enabled) {
        return (
            <HoverTip label="Published but switched off: the configuration is kept, and sign-ins through it are refused until the switch goes back on.">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-500/10 text-slate-600 dark:text-slate-300 border border-slate-500/30">
                    Off — sign-ins refused
                </span>
            </HoverTip>
        )
    }
    return (
        <HoverTip label="Live: this connection is on the sign-in page for everyone it applies to.">
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30">
                Live
            </span>
        </HoverTip>
    )
}

/** Certificate expiry is the payload that matters: an expired SAML signing
 *  cert takes every sign-in down at once, and the date was readable months
 *  ahead. "unknown" is muted, never alarming — it means not probed yet, or
 *  a kind with nothing to probe. The full detail and the check time live
 *  in the tooltip, so a long backend message is readable instead of
 *  silently truncated. */
function HealthLine({ health, kind, fetchFailed }: {
    health?: IdpHealth
    kind: string
    fetchFailed?: boolean
}) {
    if (fetchFailed) {
        // A failed status read is not the same fact as "never probed" —
        // rendering them identically made an outage look like a fresh
        // install.
        return (
            <HoverTip label="The health status could not be fetched just now. This says nothing about the connection itself — reload to retry.">
                <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-ink-muted/50" />
                    Health unavailable right now
                </span>
            </HoverTip>
        )
    }
    if (!health) {
        return <span className="text-[11px] text-ink-muted">Not checked yet</span>
    }
    const days = health.certDaysRemaining
    const dot = {
        ok: 'bg-emerald-500',
        warning: 'bg-amber-500',
        unavailable: 'bg-red-500',
        unknown: 'bg-ink-muted/50',
    }[health.status] ?? 'bg-ink-muted/50'

    let label: string
    if (days !== null && days !== undefined) {
        label = days < 0
            ? 'Certificate expired'
            : `Certificate expires in ${days} days`
    } else if (health.status === 'unknown') {
        // Say which kind of "nothing to report" this is. An indefinite dash
        // reads the same as a failed probe.
        label = kind === 'oidc' || kind === 'saml2'
            ? 'Not checked yet'
            : 'No certificate to check'
    } else {
        label = health.detail ?? health.status
    }

    const tip = (
        <span className="block space-y-1">
            <span className="block">{health.detail ?? label}</span>
            {health.checkedAt && (
                <span className="block text-ink-muted">
                    Checked {timeAgo(health.checkedAt)}.
                </span>
            )}
            <span className="block text-ink-muted">
                Green: healthy · amber: needs attention · red: failing ·
                grey: nothing to probe.
            </span>
        </span>
    )

    return (
        <HoverTip label={tip}>
            <span className="inline-flex items-center gap-1.5 text-[11px]">
                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} />
                <span className={cn(
                    'truncate',
                    health.status === 'unavailable' && 'text-red-600 dark:text-red-400',
                    health.status === 'warning' && 'text-amber-600 dark:text-amber-400',
                    (health.status === 'ok' || health.status === 'unknown') && 'text-ink-muted',
                )}>
                    {label}
                </span>
            </span>
        </HoverTip>
    )
}

function IconAction({
    icon: Icon, label, tip, onClick, disabled, pending, tone,
}: {
    icon: typeof Pencil
    label: string
    tip: React.ReactNode
    onClick: () => void
    disabled?: boolean
    pending?: boolean
    tone?: 'danger'
}) {
    return (
        <HoverTip label={tip}>
            <button
                type="button"
                onClick={onClick}
                disabled={disabled}
                aria-label={label}
                className={cn(
                    'p-2 rounded-lg border border-glass-border transition-colors duration-150 disabled:opacity-40',
                    tone === 'danger'
                        ? 'text-red-500 hover:bg-red-500/10 hover:border-red-500/30'
                        : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/5',
                )}
            >
                {pending
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Icon className="w-4 h-4" />}
            </button>
        </HoverTip>
    )
}

/** The operational switch, looking like one. The Power glyph it replaces
 *  rendered identically in both states — the only statement of
 *  enabled/disabled on the whole card was a hidden title string. */
function EnabledSwitch({ provider, onToggle, disabled, pending }: {
    provider: IdpProvider
    onToggle: () => void
    disabled?: boolean
    pending?: boolean
}) {
    const on = provider.enabled
    return (
        <HoverTip label={on
            ? 'On — people can sign in through this connection. Turning it off keeps the configuration and refuses new sign-ins (you will be asked about existing sessions first).'
            : 'Off — sign-ins through this connection are refused. The configuration is kept; turn it back on any time.'}
        >
            <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={on
                    ? `Turn off ${provider.slug}`
                    : `Turn on ${provider.slug}`}
                onClick={onToggle}
                disabled={disabled}
                className={cn(
                    'relative inline-flex h-[20px] w-9 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-40',
                    on
                        ? 'bg-emerald-500/90 border-emerald-600/40'
                        : 'bg-ink-muted/25 border-glass-border',
                )}
            >
                <span
                    className={cn(
                        'inline-flex h-[14px] w-[14px] items-center justify-center rounded-full bg-white shadow transition-transform duration-150',
                        on ? 'translate-x-[19px]' : 'translate-x-[3px]',
                    )}
                >
                    {pending && (
                        <Loader2 className="w-2.5 h-2.5 animate-spin text-ink-muted" />
                    )}
                </span>
            </button>
        </HoverTip>
    )
}

export function IdpProviderCard({
    provider, health, healthUnavailable, busy, pending, index,
    onEdit, onRehearse, onPublish, onToggleEnabled, onDelete,
}: {
    provider: IdpProvider
    health?: IdpHealth
    /** The status read itself failed — distinct from "never probed". */
    healthUnavailable?: boolean
    busy?: boolean
    /** Which of THIS card's actions is in flight. */
    pending?: CardPendingAction
    index?: number
    onEdit: () => void
    onRehearse: () => void
    onPublish: () => void
    onToggleEnabled: () => void
    onDelete: () => void
}) {
    const preset = presetById(provider.kind === 'custom_profile'
        ? 'custom_profile' : provider.kind)
    const Logo = logoFor(preset?.id, provider.kind)
    const isDraft = provider.lifecycle === 'draft'
    const isOff = !isDraft && !provider.enabled

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: (index ?? 0) * 0.04 }}
            className={cn(
                'p-4 rounded-xl border transition-colors duration-150',
                isDraft
                    ? 'border-amber-500/25 bg-amber-500/[0.03]'
                    : 'border-glass-border bg-canvas-elevated',
                // Dimmed AND said in words — the chip carries the state,
                // the dimming just keeps the scan honest.
                isOff && 'opacity-75',
            )}
        >
            <div className="flex items-start gap-3">
                {provider.buttonIcon ? (
                    // The operator-supplied mark (validated same-origin
                    // or data: — remote URLs are refused at save).
                    <img
                        src={provider.buttonIcon}
                        alt=""
                        className="w-9 h-9 shrink-0 rounded object-contain"
                    />
                ) : (
                    <Logo className="w-9 h-9 shrink-0 text-ink" />
                )}

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-ink truncate">
                            {provider.displayName}
                        </span>
                        <StatusChip provider={provider} />
                        <AssurancePill
                            level={provider.assurance}
                            reason={provider.assuranceReason}
                        />
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink-muted truncate">
                        {provider.slug}
                    </div>
                    <div className="mt-2 flex items-center gap-3 min-w-0">
                        <HealthLine
                            health={health}
                            kind={provider.kind}
                            fetchFailed={healthUnavailable}
                        />
                        {!isDraft && provider.lastAssertionAt && (
                            <HoverTip label="The most recent successful sign-in or rehearsal through this connection.">
                                <span className="text-[11px] text-ink-muted truncate">
                                    Last sign-in {timeAgo(provider.lastAssertionAt)}
                                </span>
                            </HoverTip>
                        )}
                    </div>
                    {provider.emailDomains?.length > 0 && (
                        <div className="mt-1.5 text-[11px] text-ink-muted truncate">
                            Routes {provider.emailDomains.join(', ')}
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                    {isDraft && (
                        <button
                            type="button"
                            onClick={onPublish}
                            disabled={busy}
                            className="px-3 py-2 rounded-lg bg-accent-lineage text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                        >
                            {pending === 'publish'
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Rocket className="w-3.5 h-3.5" />}
                            Publish
                        </button>
                    )}
                    <IconAction
                        icon={FlaskConical}
                        label={`Rehearse sign-in for ${provider.slug}`}
                        tip="Rehearse: sign in as yourself at this IdP. Nothing is written and no session is created — the verdict shows who would sign in and what they would be granted."
                        onClick={onRehearse}
                        disabled={busy}
                        pending={pending === 'rehearse'}
                    />
                    <EnabledSwitch
                        provider={provider}
                        onToggle={onToggleEnabled}
                        disabled={busy}
                        pending={pending === 'toggle'}
                    />
                    <IconAction
                        icon={Pencil}
                        label={`Edit ${provider.slug}`}
                        tip="Open this connection's settings."
                        onClick={onEdit}
                        disabled={busy}
                    />
                    <IconAction
                        icon={Trash2}
                        label={`Delete ${provider.slug}`}
                        tip="Opens the connection's settings at its danger zone — deleting asks you to type the slug first."
                        onClick={onDelete}
                        disabled={busy}
                        tone="danger"
                    />
                </div>
            </div>

            {/* An unverified connection that is LIVE is the combination
                worth interrupting for — it is serving real sign-ins on
                claims nothing has vouched for. */}
            {!isDraft && provider.assurance === 'unverified' && (
                <div className="mt-3 flex items-start gap-2 p-2.5 rounded-lg border border-amber-500/25 bg-amber-500/5">
                    <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
                    <p className="text-[11px] text-ink-muted">
                        This connection is live and unverified — anyone who can
                        write its payload can sign in as anyone. Privileged roles
                        cannot be mapped from it.
                    </p>
                </div>
            )}
        </motion.div>
    )
}
