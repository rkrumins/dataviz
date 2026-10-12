/**
 * How much a provider's word is worth, at a glance.
 *
 * The two trust escape hatches on a `custom_profile` provider —
 * `trust_unsigned` and `trusted_proxy_acknowledged` — used to be booleans
 * inside an encrypted settings blob. An admin scanning the providers list
 * had no way to see that "Corporate Portal" accepts identity claims it
 * cannot verify. This is that missing signal.
 *
 * Colour carries the meaning, so it must not be decorative: red is not
 * "error", it is "anyone who can write the payload can be anyone". The
 * explanation lives in a real tooltip (HoverTip) — the native `title` hid
 * the single most security-loaded sentence on the page behind a
 * one-second browser delay — and each level carries a plain-words
 * definition beside the server's per-row reason.
 */
import { ShieldCheck, ShieldAlert, ShieldX, ShieldQuestion } from 'lucide-react'
import type { AssuranceLevel } from '@/services/ssoAdminService'
import { HoverTip } from '@/components/ui/HoverTip'
import { cn } from '@/lib/utils'

const STYLES: Record<AssuranceLevel, {
    label: string
    className: string
    Icon: typeof ShieldCheck
    meaning: string
}> = {
    verified: {
        label: 'Verified',
        className: 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5',
        Icon: ShieldCheck,
        meaning: 'A cryptographic signature (or a server-to-server call we '
            + 'made ourselves) stands behind every claim.',
    },
    asserted: {
        label: 'Asserted',
        className: 'border-yellow-500/30 text-yellow-600 dark:text-yellow-400 bg-yellow-500/5',
        Icon: ShieldAlert,
        meaning: 'The claims arrive over a trusted channel but carry no '
            + 'signature of their own.',
    },
    unverified: {
        label: 'Unverified',
        className: 'border-red-500/30 text-red-600 dark:text-red-400 bg-red-500/5',
        Icon: ShieldX,
        meaning: 'Nothing vouches for the claims: anyone who can write the '
            + 'payload can sign in as anyone. Privileged roles cannot be '
            + 'mapped from this connection.',
    },
}

const UNKNOWN = {
    label: 'Unknown',
    className: 'border-glass-border text-ink-muted bg-black/[0.03] dark:bg-white/[0.04]',
    Icon: ShieldQuestion,
    meaning: 'This server reports an assurance level this page does not '
        + 'know yet — likely a newer backend. Check the connection’s '
        + 'settings for the details.',
}

export function AssurancePill({
    level, reason, className,
}: {
    level: AssuranceLevel
    /** Server-supplied explanation; shown in the tooltip. */
    reason?: string
    className?: string
}) {
    // An unrecognised level from a newer backend gets a neutral pill that
    // says so — the old fallback painted it red, inventing an alarm for a
    // level nobody had defined.
    const style = STYLES[level] ?? UNKNOWN
    const { Icon } = style
    return (
        <HoverTip label={(
            <span className="block space-y-1">
                <span className="block font-semibold">{style.label}</span>
                <span className="block">{style.meaning}</span>
                {reason && (
                    <span className="block text-ink-muted">{reason}</span>
                )}
            </span>
        )}>
            <span
                className={cn(
                    'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border',
                    'text-[10px] font-medium whitespace-nowrap',
                    style.className,
                    className,
                )}
            >
                <Icon className="w-3 h-3 shrink-0" />
                {style.label}
            </span>
        </HoverTip>
    )
}
