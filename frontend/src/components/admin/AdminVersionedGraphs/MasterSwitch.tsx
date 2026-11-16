/**
 * A category's master switch (New-version builds, Graph residency): whether the feature switch its
 * settings need is on, who turned it on or off and when, and the switch itself, which asks first
 * as Admin → Features does (`useFeatureSwitches`).
 */
import { Power, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DateTime } from '@/components/ui/DateTime'
import { Skeleton } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import type { FeatureSwitches } from './useFeatureSwitches'

export function MasterSwitchCard({ featureKey, switches, readOnly = false }: {
    featureKey: string
    switches: FeatureSwitches
    /** A viewer who may only read the settings sees the switch, not flips it. */
    readOnly?: boolean
}) {
    if (switches.loading) return <Skeleton className="h-24 rounded-2xl" />
    if (switches.error) {
        return (
            <Card padding="md" className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-[13px] text-ink-secondary">Couldn’t read whether this category’s switch is on: {switches.error.message}</p>
                <Button size="sm" leftIcon={RotateCw} onClick={switches.retry}>Try again</Button>
            </Card>
        )
    }
    const feature = switches.definition(featureKey)
    const on = switches.on(featureKey)
    // A switch the Features API doesn't know draws nothing: its settings say they are inactive.
    if (!feature || on === undefined) return null
    const last = switches.lastChange(featureKey)
    const id = `switch-${featureKey}`
    return (
        <Card padding="md" className={cn(on ? '' : 'border-amber-500/25 bg-amber-500/[0.03]')}>
            <div className="flex items-start gap-4">
                <span className={cn('grid place-items-center w-10 h-10 shrink-0 rounded-xl',
                    on ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-black/[0.05] text-ink-muted dark:bg-white/[0.06]')}>
                    <Power aria-hidden className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Switch for this category</p>
                    <h3 id={id} className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{feature.name}</h3>
                    <p className={cn('mt-1 text-xs font-medium', on ? 'text-ink-secondary' : 'text-amber-700 dark:text-amber-300')} aria-live="polite">
                        {on ? 'On: the settings below are in effect.' : 'Off: the settings below are kept, and take effect once it is on.'}
                    </p>
                    {last && (
                        <p className="mt-0.5 text-[11px] text-ink-muted">
                            Turned {last.to === false ? 'off' : 'on'} by {last.actorName} · <DateTime at={last.at} />
                        </p>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-1">
                    <span className="text-[13px] font-medium text-ink-secondary" aria-hidden>{on ? 'On' : 'Off'}</span>
                    <Switch checked={on} disabled={readOnly || switches.saving === featureKey} aria-labelledby={id}
                        onChange={(next) => switches.request(featureKey, next)} />
                </div>
            </div>
        </Card>
    )
}
