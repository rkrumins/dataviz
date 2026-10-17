/**
 * A key's life on one line: made, today, and when it stops.
 *
 * The fill is how much of it is gone, coloured by how close the end is, with
 * "today" flagged where it falls; a key that never expires gets a track that
 * fades out rather than ends, and one that has ended — expired or revoked — a
 * full, quiet bar.
 */
import { cn } from '@/lib/utils'
import type { ApiKey } from '@/services/apiKeyService'
import { expiryCountdown, formatDay } from './apiKeyFormat'

const FILL = {
    urgent: 'bg-rose-500',
    soon: 'bg-amber-500',
    calm: 'bg-gradient-to-r from-indigo-500 to-violet-500',
    never: 'bg-gradient-to-r from-indigo-500 to-violet-500',
    ended: 'bg-slate-300 dark:bg-slate-600',
} as const

const TEXT = {
    urgent: 'text-rose-600 dark:text-rose-400',
    soon: 'text-amber-600 dark:text-amber-400',
    calm: 'text-ink',
    never: 'text-ink',
    ended: 'text-ink-muted',
} as const

export function LifetimeBar({ apiKey, now = new Date() }: {
    apiKey: Pick<ApiKey, 'createdAt' | 'expiresAt' | 'revokedAt' | 'status' | 'revokedReason'>
    now?: Date
}) {
    const created = new Date(apiKey.createdAt).getTime()
    const ended = Boolean(apiKey.revokedAt) || apiKey.status === 'expired'
    const countdown = expiryCountdown(apiKey.expiresAt, now)
    const tone = ended ? 'ended' : countdown.tone
    const end = apiKey.expiresAt ? new Date(apiKey.expiresAt).getTime() : null
    const pct = ended || end === null ? 100
        : Math.min(100, Math.max(2, ((now.getTime() - created) / Math.max(1, end - created)) * 100))

    const endLabel = apiKey.revokedAt
        ? `${apiKey.revokedReason === 'rotated' ? 'Replaced' : 'Revoked'} ${formatDay(apiKey.revokedAt, now)}`
        : apiKey.expiresAt
            ? `${apiKey.status === 'expired' ? 'Expired' : 'Expires'} ${formatDay(apiKey.expiresAt, now)}`
            : 'No end date'
    const flagged = !ended && end !== null

    return (
        <div role="img" aria-label={`Created ${formatDay(apiKey.createdAt, now)}; ${endLabel}`}>
            <div className={cn('relative', flagged && 'pt-6')}>
                {flagged && (
                    <span
                        aria-hidden
                        className="absolute top-0 -translate-x-1/2 whitespace-nowrap px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-black/[0.05] dark:bg-white/[0.08] text-ink-secondary"
                        style={{ left: `${Math.min(88, Math.max(12, pct))}%` }}
                    >
                        Today · {Math.round(pct)}% gone
                    </span>
                )}
                <div className="relative h-2.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                    <div
                        className={cn(
                            'absolute inset-y-0 left-0 rounded-full', FILL[tone],
                            end === null && !ended && '[mask-image:linear-gradient(to_right,black_55%,transparent)]',
                        )}
                        style={{ width: `${pct}%` }}
                    />
                    {flagged && (
                        <span
                            aria-hidden
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 rounded-full bg-canvas-elevated border-[3px] border-indigo-500 shadow"
                            style={{ left: `${pct}%` }}
                        />
                    )}
                </div>
            </div>
            <div className="mt-2.5 flex items-start justify-between gap-3 text-[11px]">
                <span>
                    <span className="block font-semibold text-ink">Created</span>
                    <span className="text-ink-muted">{formatDay(apiKey.createdAt, now)}</span>
                </span>
                <span className="text-right">
                    <span className={cn('block font-semibold', TEXT[tone])}>
                        {ended ? 'Ended' : countdown.label}
                    </span>
                    <span className="text-ink-muted">{endLabel}</span>
                </span>
            </div>
        </div>
    )
}
