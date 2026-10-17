/**
 * Small pieces every API key surface shares — the status badge, a level
 * pill and the expiry countdown — so the account page, the drawer and the
 * admin inventory say the same thing the same way.
 */
import { Hourglass, Infinity as InfinityIcon, TimerOff } from 'lucide-react'

import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import type { ApiKey, Level } from '@/services/apiKeyService'
import { expiryCountdown, formatDay, statusLabel, type Urgency } from './apiKeyFormat'

function statusTone(key: Pick<ApiKey, 'status' | 'revokedReason'>): BadgeTone {
    switch (key.status) {
        case 'active': return 'success'
        case 'paused': return 'warning'
        case 'ip_not_allowed': return 'warning'
        case 'owner_inactive': return 'danger'
        case 'revoked': return key.revokedReason === 'rotated' ? 'info' : 'neutral'
        default: return 'neutral'
    }
}

export function KeyStatusBadge({ apiKey, short }: {
    apiKey: Pick<ApiKey, 'status' | 'revokedReason'>
    /** "Paused" rather than "Paused — sign in to resume", where the page says the rest. */
    short?: boolean
}) {
    const label = short && apiKey.status === 'paused' ? 'Paused' : statusLabel(apiKey)
    return (
        <Badge tone={statusTone(apiKey)} size="md" className="shrink-0">
            {apiKey.status === 'active' && <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-emerald-500" />}
            {label}
        </Badge>
    )
}

const LEVEL_PILL: Record<Level, { label: string; className: string }> = {
    none: { label: 'None', className: 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted' },
    read: { label: 'Read', className: 'bg-sky-500/10 text-sky-700 dark:text-sky-300' },
    write: { label: 'Read & write', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
}

export function LevelPill({ level, className }: { level: Level; className?: string }) {
    const pill = LEVEL_PILL[level]
    return (
        <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap', pill.className, className)}>
            {pill.label}
        </span>
    )
}

/** Text colour for how close an expiry is. */
const URGENCY_TEXT: Record<Urgency, string> = {
    urgent: 'text-rose-600 dark:text-rose-400',
    soon: 'text-amber-600 dark:text-amber-400',
    calm: 'text-ink',
    never: 'text-ink',
    ended: 'text-ink-muted',
}

const URGENCY_ICON = { urgent: Hourglass, soon: Hourglass, calm: Hourglass, never: InfinityIcon, ended: TimerOff }

/** "Expires in 5 days", coloured by how soon, with the date beneath. `compact`
 *  is for a column already headed "Expires": "in 5 days". */
export function ExpiryFact({ expiresAt, compact }: { expiresAt: string | null; compact?: boolean }) {
    const c = expiryCountdown(expiresAt)
    const label = compact ? c.label.replace(/^Expires in/, 'In') : c.label
    const Icon = URGENCY_ICON[c.tone]
    return (
        <span className="min-w-0">
            <span className={cn('flex items-center gap-1.5 font-semibold', compact ? 'text-xs' : 'text-sm', URGENCY_TEXT[c.tone])}>
                <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
            </span>
            {expiresAt && (
                <span className="block mt-0.5 text-[11px] text-ink-muted truncate">
                    {formatDay(expiresAt)}
                </span>
            )}
        </span>
    )
}
