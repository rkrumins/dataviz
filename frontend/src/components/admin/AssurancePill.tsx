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
 * "error", it is "anyone who can write the payload can be anyone".
 */
import { ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react'
import type { AssuranceLevel } from '@/services/ssoAdminService'
import { cn } from '@/lib/utils'

const STYLES: Record<AssuranceLevel, {
    label: string
    className: string
    Icon: typeof ShieldCheck
}> = {
    verified: {
        label: 'Verified',
        className: 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5',
        Icon: ShieldCheck,
    },
    asserted: {
        label: 'Asserted',
        className: 'border-yellow-500/30 text-yellow-400 bg-yellow-500/5',
        Icon: ShieldAlert,
    },
    unverified: {
        label: 'Unverified',
        className: 'border-red-500/30 text-red-400 bg-red-500/5',
        Icon: ShieldX,
    },
}

export function AssurancePill({
    level, reason, className,
}: {
    level: AssuranceLevel
    /** Server-supplied explanation; surfaced as the tooltip. */
    reason?: string
    className?: string
}) {
    // An unrecognised level from a newer backend reads as unverified rather
    // than rendering nothing — a missing pill would look like "fine".
    const style = STYLES[level] ?? STYLES.unverified
    const { Icon } = style
    return (
        <span
            title={reason || style.label}
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
    )
}
