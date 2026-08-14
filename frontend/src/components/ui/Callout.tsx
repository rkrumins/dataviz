/**
 * Callout — the one inline advisory/status block.
 *
 * Every banner in the app used to be hand-rolled, so tone, icon, radius and
 * ink drifted between surfaces that sit next to each other. This is the
 * shared primitive; adopt it rather than restyling a `<div>`.
 *
 * Two rules it enforces so callers cannot get them wrong:
 *
 *  1. **Severity is never carried by colour alone.** Each tone ships a fixed
 *     icon, and colour-blind readers, forced-colours mode and greyscale print
 *     all still resolve the tone. (On a light surface `warning` and `serious`
 *     sit below 3:1 by design — the icon pairing is the mitigation.)
 *  2. **Status tones are reserved.** info / warning / serious / critical mean
 *     state. They are not decoration and never stand in for a category colour.
 *
 * Body text wears its tone's ink; supporting text stays on the neutral ink
 * tokens so a callout never becomes a wall of coloured prose.
 */
import type { JSX, ReactNode } from 'react'
import { Info, AlertTriangle, AlertOctagon, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CalloutTone = 'info' | 'warning' | 'serious' | 'critical'

interface ToneSpec {
    icon: typeof Info
    /** Accessible prefix — the tone in words, for readers that get no colour. */
    srLabel: string
    container: string
    icon_: string
    body: string
}

const TONES: Record<CalloutTone, ToneSpec> = {
    info: {
        icon: Info,
        srLabel: 'Information',
        container: 'bg-indigo-500/[0.06] border-indigo-500/20',
        icon_: 'text-indigo-500',
        body: 'text-indigo-600/90 dark:text-indigo-300/90',
    },
    warning: {
        icon: AlertTriangle,
        srLabel: 'Warning',
        container: 'bg-amber-500/[0.06] border-amber-500/20',
        icon_: 'text-amber-500',
        body: 'text-amber-600/90 dark:text-amber-400/90',
    },
    serious: {
        icon: AlertOctagon,
        srLabel: 'Serious',
        container: 'bg-orange-500/[0.06] border-orange-500/20',
        icon_: 'text-orange-500',
        body: 'text-orange-600/90 dark:text-orange-400/90',
    },
    critical: {
        icon: AlertCircle,
        srLabel: 'Critical',
        container: 'bg-red-500/[0.06] border-red-500/20',
        icon_: 'text-red-500',
        body: 'text-red-600/90 dark:text-red-400/90',
    },
}

export interface CalloutProps {
    tone?: CalloutTone
    /** Optional bold lead-in. Sentence case, no trailing colon. */
    title?: string
    children: ReactNode
    /** Extra content below the body — actions, a disclosure, a meter. */
    footer?: ReactNode
    className?: string
}

export function Callout({
    tone = 'info',
    title,
    children,
    footer,
    className,
}: CalloutProps): JSX.Element {
    const spec = TONES[tone]
    const Icon = spec.icon
    return (
        <div
            role="note"
            className={cn(
                'flex items-start gap-2 rounded-lg border px-3 py-2',
                spec.container,
                className,
            )}
        >
            <Icon className={cn('w-3.5 h-3.5 flex-shrink-0 mt-0.5', spec.icon_)} aria-hidden="true" />
            <div className="min-w-0 flex-1">
                {/* The tone in words — colour and icon are both visual-only. */}
                <span className="sr-only">{spec.srLabel}: </span>
                {title && (
                    <p className={cn('text-[11px] font-semibold leading-relaxed', spec.body)}>
                        {title}
                    </p>
                )}
                <div className={cn('text-[11px] leading-relaxed', spec.body)}>{children}</div>
                {footer && <div className="mt-2">{footer}</div>}
            </div>
        </div>
    )
}

export default Callout
