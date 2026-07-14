/**
 * One feature, as a card you can read in two seconds.
 *
 * The old row was a name, a sentence and a switch — which tells you what the feature is CALLED and
 * nothing about what it is doing to your users. Three things changed:
 *
 *   1. STATE IS ON THE FACE OF IT. Off isn't "the toggle looks left"; the card changes colour and
 *      says what people cannot do. You should be able to spot a restricted deployment across a room.
 *   2. AN OFF FEATURE CARRIES ITS CONSEQUENCE. The impact sentence is not hidden behind a click
 *      while the feature is off, because then it isn't a warning about the future — it's a
 *      description of the product your users are looking at right now.
 *   3. "NO EFFECT" IS A STATE. A switch that is ON while a dependency is OFF is doing nothing, and
 *      says so, instead of quietly implying it's in force.
 */
import { ArrowRight, ShieldCheck, Loader2, Lock, ZapOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { resolveCategoryStyle } from './constants'
import { ToggleSwitch } from './ToggleSwitch'
import type { FeatureCategory, FeatureDefinition } from '@/services/featuresService'
import { blockedBy, selectionLabel, stateOf, isOn } from './featureState'

export function FeatureTile({
    feature,
    allFeatures,
    values,
    meta,
    saving,
    onToggle,
    onOpen,
}: {
    feature: FeatureDefinition
    allFeatures: FeatureDefinition[]
    values: Record<string, unknown>
    meta: FeatureCategory | undefined
    saving: boolean
    /** Asks the page to flip it. Turning OFF routes through a confirmation — see index.tsx. */
    onToggle: (next: boolean) => void
    onOpen: () => void
}) {
    const state = stateOf(feature, allFeatures, values)
    const on = isOn(feature, values)
    const blockers = blockedBy(feature, allFeatures, values)
    const selection = selectionLabel(feature, values)
    const { Icon, style } = resolveCategoryStyle(meta, feature.category)

    return (
        <div
            className={cn(
                'group relative flex flex-col rounded-2xl border bg-canvas-elevated p-5 transition-all duration-200',
                'hover:shadow-xl hover:-translate-y-0.5',
                state === 'off'
                    ? 'border-amber-500/30 bg-amber-500/[0.03]'
                    : 'border-glass-border hover:border-indigo-500/25',
            )}
        >
            {/* The whole card opens the detail sheet. The toggle sits above it and stops the click,
                so a deliberate flip never opens a panel you didn't ask for. */}
            <button
                type="button"
                onClick={onOpen}
                className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60"
                aria-label={`Details for ${feature.name}`}
            />

            <div className="relative flex items-start gap-3 pointer-events-none">
                <div
                    className={cn(
                        'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                        style.iconBg,
                    )}
                >
                    <Icon className="w-4 h-4" />
                </div>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <h3 className="text-sm font-semibold text-ink">{feature.name}</h3>
                        {feature.enforcedServerSide && (
                            <ShieldCheck
                                className="w-3.5 h-3.5 text-emerald-500/80"
                                aria-label="Enforced by the server"
                            />
                        )}
                        {feature.posture === 'security' && (
                            <Lock className="w-3 h-3 text-rose-500/80" aria-label="Security setting" />
                        )}
                    </div>
                    <p className="mt-1 text-xs text-ink-muted leading-relaxed line-clamp-2">
                        {feature.description}
                    </p>
                </div>

                <div className="shrink-0 flex items-center gap-2 pointer-events-auto">
                    {saving && <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />}
                    {feature.type === 'boolean' && (
                        <ToggleSwitch
                            checked={on}
                            onChange={onToggle}
                            disabled={saving}
                            aria-label={`Turn ${feature.name} ${on ? 'off' : 'on'}`}
                        />
                    )}
                    {selection && (
                        <span className="px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border">
                            {selection}
                        </span>
                    )}
                </div>
            </div>

            {/* OFF is not a hypothetical — it's what your users are looking at. Say it without
                being asked. */}
            {state === 'off' && feature.impactWhenOff && (
                <p className="relative mt-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200 pointer-events-none line-clamp-2">
                    {feature.impactWhenOff}
                </p>
            )}

            {state === 'inert' && (
                <p className="relative mt-3 inline-flex items-start gap-1.5 text-xs leading-relaxed text-ink-muted pointer-events-none">
                    <ZapOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>
                        On, but doing nothing —{' '}
                        <span className="font-medium text-ink-secondary">
                            {blockers.map(b => b.name).join(' and ')}
                        </span>{' '}
                        {blockers.length > 1 ? 'are' : 'is'} off.
                    </span>
                </p>
            )}

            <div className="relative mt-auto pt-4 flex items-center justify-between pointer-events-none">
                <StatePill state={state} />
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity">
                    Details
                    <ArrowRight className="w-3 h-3" />
                </span>
            </div>
        </div>
    )
}

function StatePill({ state }: { state: ReturnType<typeof stateOf> }) {
    const look = {
        on: { label: 'Available', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25' },
        partial: { label: 'Limited', cls: 'bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/25' },
        off: { label: 'Turned off', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' },
        inert: { label: 'No effect', cls: 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border' },
    }[state]

    return (
        <span
            className={cn(
                'inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold border',
                look.cls,
            )}
        >
            {look.label}
        </span>
    )
}
