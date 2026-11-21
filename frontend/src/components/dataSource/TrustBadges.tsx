/**
 * Whether to rely on a data source, at a glance: its trust status — Certified, In review,
 * Deprecated — as a tinted pill, and how sensitive its data is as a quieter tag beside it,
 * so the two never read as one scale. Its named Owner and Stewards and the workspace's
 * admins set both. "Restricted" here is a sensitivity label; the tooltip says it is not
 * the admin's restricted-publishing setting, which decides whether views need approval.
 */
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import {
    CLASSIFICATION_LABEL, TRUST_LABEL, type Classification, type TrustStatus,
} from '@/services/dataSourceMetadataService'
import { CLASSIFICATION_META, TRUST_META } from './trustMeta'

const SIZE = {
    sm: { pill: 'gap-1 px-2 py-0.5 text-[10px]', icon: 'h-3 w-3' },
    md: { pill: 'gap-1.5 px-2.5 py-1 text-[11px]', icon: 'h-3.5 w-3.5' },
} as const

/** Wrapped in a tooltip unless the caller already sits in one (`tip={false}`). */
function Tipped({ tip, label, detail, children }: { tip: boolean; label: string; detail: string; children: React.ReactElement }) {
    return tip ? <HoverTip label={label} detail={detail}>{children}</HoverTip> : children
}

export function TrustStatusBadge({ status, size = 'sm', tip = true, className }: {
    status: TrustStatus
    size?: keyof typeof SIZE
    tip?: boolean
    className?: string
}) {
    const meta = TRUST_META[status]
    const Icon = meta.icon
    return (
        <Tipped tip={tip} label={meta.tip} detail={meta.detail}>
            <span data-trust={status} className={cn('inline-flex shrink-0 items-center rounded-full border font-semibold', SIZE[size].pill, meta.pill, className)}>
                <Icon className={SIZE[size].icon} aria-hidden />
                {TRUST_LABEL[status]}
            </span>
        </Tipped>
    )
}

export function ClassificationBadge({ classification, size = 'sm', tip = true, className }: {
    classification: Classification
    size?: keyof typeof SIZE
    tip?: boolean
    className?: string
}) {
    const meta = CLASSIFICATION_META[classification]
    const Icon = meta.icon
    return (
        <Tipped tip={tip} label={meta.tip} detail={meta.detail}>
            <span data-classification={classification} className={cn(
                'inline-flex shrink-0 items-center rounded-md border font-semibold text-ink-secondary',
                'border-black/[0.08] bg-black/[0.03] dark:border-white/[0.10] dark:bg-white/[0.04]',
                SIZE[size].pill, className,
            )}>
                <Icon className={cn(SIZE[size].icon, meta.glyph)} aria-hidden />
                {CLASSIFICATION_LABEL[classification]}
            </span>
        </Tipped>
    )
}

/** Both, where a source has them — or nothing. */
export function TrustBadges({ trustStatus, classification, size, tip, className }: {
    trustStatus?: TrustStatus | null
    classification?: Classification | null
    size?: keyof typeof SIZE
    tip?: boolean
    className?: string
}) {
    if (!trustStatus && !classification) return null
    return (
        <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
            {trustStatus && <TrustStatusBadge status={trustStatus} size={size} tip={tip} />}
            {classification && <ClassificationBadge classification={classification} size={size} tip={tip} />}
        </span>
    )
}
