/**
 * One connection, as a card.
 *
 * The table this replaces had seven columns — Slug, Display, Kind, Health,
 * Linking, Enabled, actions — which is a view of a database row. The
 * questions an operator actually arrives with are "is this thing working?"
 * and "can people use it yet?", and neither had a column.
 *
 * So the card leads with the vendor mark and the two states that answer
 * them: the lifecycle chip (can anyone see this?) and health (is it about
 * to break?). Assurance sits alongside because "we cannot tell a real
 * claim from a forged one" belongs next to the name, not three columns
 * over.
 */
import { motion } from 'framer-motion'
import {
    Pencil, Trash2, Power, FlaskConical, Rocket, ShieldAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { IdpProvider, IdpHealth } from '@/services/ssoAdminService'
import { AssurancePill } from '@/components/admin/AssurancePill'
import { logoFor } from './IdpLogos'
import { presetById } from './vendorPresets'

/** Draft vs live, stated plainly. This is the single most important thing
 *  on the card: it is the difference between "I am still setting this up"
 *  and "every person who loads the sign-in page sees this". */
function LifecycleChip({ lifecycle }: { lifecycle?: string }) {
    if (lifecycle === 'draft') {
        return (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-300 border border-amber-500/30">
                Draft — not visible to anyone
            </span>
        )
    }
    return (
        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30">
            Live
        </span>
    )
}

/** Certificate expiry is the payload that matters: an expired SAML signing
 *  cert takes every sign-in down at once, and the date was readable months
 *  ahead. "unknown" is muted, never alarming — it means not probed yet, or
 *  a kind with nothing to probe. */
function HealthLine({ health, kind }: { health?: IdpHealth; kind: string }) {
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

    return (
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
    )
}

function IconAction({
    icon: Icon, label, onClick, disabled, tone,
}: {
    icon: typeof Pencil
    label: string
    onClick: () => void
    disabled?: boolean
    tone?: 'danger'
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label}
            className={cn(
                'p-2 rounded-lg border border-glass-border transition-colors duration-150 disabled:opacity-40',
                tone === 'danger'
                    ? 'text-red-500 hover:bg-red-500/10 hover:border-red-500/30'
                    : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/5',
            )}
        >
            <Icon className="w-4 h-4" />
        </button>
    )
}

export function IdpProviderCard({
    provider, health, busy, index,
    onEdit, onRehearse, onPublish, onToggleEnabled, onDelete,
}: {
    provider: IdpProvider
    health?: IdpHealth
    busy?: boolean
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
                !provider.enabled && 'opacity-60',
            )}
        >
            <div className="flex items-start gap-3">
                <Logo className="w-9 h-9 shrink-0 text-ink" />

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-ink truncate">
                            {provider.displayName}
                        </span>
                        <LifecycleChip lifecycle={provider.lifecycle} />
                        <AssurancePill
                            level={provider.assurance}
                            reason={provider.assuranceReason}
                        />
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink-muted truncate">
                        {provider.slug}
                    </div>
                    <div className="mt-2">
                        <HealthLine health={health} kind={provider.kind} />
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
                            <Rocket className="w-3.5 h-3.5" />
                            Publish
                        </button>
                    )}
                    <IconAction
                        icon={FlaskConical}
                        label={`Rehearse sign-in for ${provider.slug}`}
                        onClick={onRehearse}
                        disabled={busy}
                    />
                    <IconAction
                        icon={Power}
                        label={provider.enabled
                            ? `Turn off ${provider.slug}`
                            : `Turn on ${provider.slug}`}
                        onClick={onToggleEnabled}
                        disabled={busy}
                    />
                    <IconAction
                        icon={Pencil}
                        label={`Edit ${provider.slug}`}
                        onClick={onEdit}
                        disabled={busy}
                    />
                    <IconAction
                        icon={Trash2}
                        label={`Delete ${provider.slug}`}
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
