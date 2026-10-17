/**
 * How long a key lasts, as choices that say the date they end on — "30 days"
 * means little until it reads "until Thu, Nov 12". Only what the deployment
 * allows is offered; "never" is flagged, because nothing but a revocation
 * ends such a key.
 */
import { CalendarDays } from 'lucide-react'

import { BigInput, Hint } from '@/components/admin/InviteWizard/ui'
import { cn } from '@/lib/utils'
import { expiryOptions, formatDay, type ExpiryChoice } from './apiKeyFormat'

const DAY = 24 * 60 * 60 * 1000

export function ExpiryPicker({ value, customDate, onChange, onCustomDate, maxLifetimeDays, same, dateProblem, now = new Date() }: {
    value: ExpiryChoice | 'same'
    customDate: string
    onChange: (value: ExpiryChoice | 'same') => void
    onCustomDate: (date: string) => void
    maxLifetimeDays: number | null
    /** Offer "same as before", saying how long that is. */
    same?: string
    dateProblem?: string | null
    now?: Date
}) {
    const options: { value: ExpiryChoice | 'same'; label: string; sub: string; warn?: boolean }[] = [
        ...(same ? [{ value: 'same' as const, label: 'Same as before', sub: same }] : []),
        ...expiryOptions(maxLifetimeDays).map((o) => ({
            value: o.value,
            label: o.label,
            sub: o.value === 'never' ? 'Until revoked'
                : o.value === 'custom' ? 'Pick a day'
                    : `Until ${formatDay(new Date(now.getTime() + Number(o.value) * DAY).toISOString(), now)}`,
            warn: o.value === 'never',
        })),
    ]
    const tomorrow = new Date(now.getTime() + DAY).toISOString().slice(0, 10)
    const latest = maxLifetimeDays !== null
        ? new Date(now.getTime() + maxLifetimeDays * DAY).toISOString().slice(0, 10)
        : undefined

    return (
        <div>
            <div role="radiogroup" aria-label="Expires" className={cn('grid grid-cols-2 gap-2', options.length > 6 ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
                {options.map((o) => {
                    const on = value === o.value
                    return (
                        <button
                            key={o.value}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => onChange(o.value)}
                            className={cn(
                                'px-3 py-2.5 rounded-xl border-2 text-left transition-colors duration-150',
                                on
                                    ? o.warn ? 'border-amber-500 bg-amber-500/[0.08]' : 'border-indigo-500 bg-indigo-500/[0.07]'
                                    : 'border-black/[0.10] dark:border-white/[0.12] bg-canvas-elevated hover:border-indigo-500/40',
                            )}
                        >
                            <span className={cn(
                                'block text-sm font-semibold',
                                on ? (o.warn ? 'text-amber-700 dark:text-amber-300' : 'text-indigo-600 dark:text-indigo-400') : 'text-ink',
                            )}>
                                {o.label}
                            </span>
                            {' '}
                            <span className={cn('block text-[11px] mt-0.5 truncate', o.warn ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted')}>
                                {o.sub}
                            </span>
                        </button>
                    )
                })}
            </div>
            {value === 'custom' && (
                <div className="mt-3 max-w-xs">
                    <BigInput
                        type="date"
                        icon={CalendarDays}
                        aria-label="Last day it works"
                        min={tomorrow}
                        max={latest}
                        value={customDate}
                        state={customDate && dateProblem ? 'invalid' : 'idle'}
                        onChange={(e) => onCustomDate(e.target.value)}
                    />
                    {customDate && dateProblem && <Hint tone="warn">{dateProblem}</Hint>}
                </div>
            )}
            {value === 'never' && (
                <Hint tone="warn">
                    A key that never expires keeps working until someone revokes it. Rotate it on a schedule you keep.
                </Hint>
            )}
            {maxLifetimeDays !== null && value !== 'never' && (
                <Hint>Keys here last at most {maxLifetimeDays} days.</Hint>
            )}
        </div>
    )
}
