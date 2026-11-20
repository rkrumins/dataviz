/**
 * A category's master switch (New-version builds, Graph residency): whether the feature switch its
 * settings need is on, who turned it on or off and when, and the switch itself, which asks first
 * as Admin → Features does (`useFeatureSwitches`). Below the platform (a workspace's page) the
 * switch is shown, not flipped: `MasterSwitchStatus`.
 */
import { Power, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DateTime } from '@/components/ui/DateTime'
import { Skeleton } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import { FEATURE_NAMES } from '@/components/settings'
import { useFeature } from '@/store/features'
import type { FeatureSwitches } from './useFeatureSwitches'

/** Whether a category's switch is on for the whole platform, read-only: a system admin turns it, in Admin → Versioned graphs. */
export function MasterSwitchStatus({ featureKey }: { featureKey: string }) {
    const on = useFeature(featureKey)
    return (
        <Card padding="md" className={cn(on ? '' : 'border-amber-500/25 bg-amber-500/[0.03]')}>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <span className={cn('hidden w-10 h-10 shrink-0 place-items-center rounded-xl sm:grid',
                    on ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.06]')}>
                    <Power aria-hidden className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex-1 basis-56">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Switch for this category</p>
                    <h3 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{FEATURE_NAMES[featureKey] ?? featureKey}</h3>
                    <p className={cn('mt-1 text-xs font-medium', on ? 'text-ink-secondary' : 'text-amber-800 dark:text-amber-300')}>
                        {on ? 'On for the whole platform: the settings below are in effect.'
                            : 'Off for the whole platform: the settings below are kept, and take effect once a system admin turns it on.'}
                    </p>
                </div>
                <span className={cn('ml-auto mt-1 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                    on ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.07]')}>
                    {on ? 'On' : 'Off'}
                </span>
            </div>
        </Card>
    )
}

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
            {/* On a phone the switch drops under its words rather than squeezing them into a column. */}
            <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <span className={cn('hidden w-10 h-10 shrink-0 place-items-center rounded-xl sm:grid',
                    on ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.06]')}>
                    <Power aria-hidden className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex-1 basis-56">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Switch for this category</p>
                    <h3 id={id} className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{feature.name}</h3>
                    <p className={cn('mt-1 text-xs font-medium', on ? 'text-ink-secondary' : 'text-amber-700 dark:text-amber-300')} aria-live="polite">
                        {on ? 'On: the settings below are in effect.' : 'Off: the settings below are kept, and take effect once it is on.'}
                    </p>
                    {last && (
                        <p className="mt-0.5 text-[11px] text-ink-secondary">
                            Turned {last.to === false ? 'off' : 'on'} by {last.actorName} · <DateTime at={last.at} />
                        </p>
                    )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2 pt-1">
                    <span className="text-[13px] font-medium text-ink-secondary" aria-hidden>{on ? 'On' : 'Off'}</span>
                    <Switch checked={on} disabled={readOnly || switches.saving === featureKey} aria-labelledby={id}
                        onChange={(next) => switches.request(featureKey, next)} />
                </div>
            </div>
        </Card>
    )
}
