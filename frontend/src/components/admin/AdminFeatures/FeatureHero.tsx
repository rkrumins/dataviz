/**
 * The state of the deployment, before you read a single switch.
 *
 * Twelve toggles laid out in a list is twelve reads to answer one question — "what can't my users
 * do right now?" — and that question is the reason anyone opens this page. So it is answered first,
 * in one line, and the switches come after.
 *
 * The strip is one segment per feature, coloured by state. It is not decoration: an amber segment
 * is a capability your users do not have, and clicking it takes you to it. A grey one is a feature
 * that SAYS it's on and is doing nothing, because something it depends on is off — the state that
 * had no representation anywhere in the old page, and the one most likely to be a mistake.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FeatureDefinition } from '@/services/featuresService'
import { stateOf, type FeatureState } from './featureState'

const SEGMENT: Record<FeatureState, string> = {
    on: 'bg-emerald-500',
    partial: 'bg-sky-500',
    off: 'bg-amber-500',
    inert: 'bg-ink-muted/40',
}

const LEGEND: { state: FeatureState; label: string }[] = [
    { state: 'on', label: 'Available' },
    { state: 'partial', label: 'Limited' },
    { state: 'off', label: 'Turned off' },
    { state: 'inert', label: 'No effect' },
]

export function FeatureHero({
    features,
    values,
    onSelect,
}: {
    features: FeatureDefinition[]
    values: Record<string, unknown>
    onSelect: (key: string) => void
}) {
    const live = features.filter(f => !f.deprecated)
    if (!live.length) return null

    const withState = live.map(f => ({ feature: f, state: stateOf(f, live, values) }))
    const active = withState.filter(f => f.state === 'on' || f.state === 'partial')
    const restricted = withState.filter(f => f.state === 'off')
    const doingNothing = withState.filter(f => f.state === 'inert')

    // Computed from the code (config/feature_wiring.py), never asserted by hand. If a decorative
    // switch ever reappears, this page says so rather than presenting it as real.
    const decorative = live.filter(f => f.enforcedServerSide !== true)

    return (
        <section className="mb-8 rounded-3xl border border-glass-border bg-canvas-elevated overflow-hidden">
            <div className="p-6 sm:p-8">
                <div className="flex flex-wrap items-end justify-between gap-6">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                            This deployment
                        </p>
                        <p className="mt-2 text-3xl sm:text-4xl font-bold tracking-tight text-ink">
                            {active.length} of {live.length}{' '}
                            <span className="text-ink-muted font-semibold">features available</span>
                        </p>
                    </div>

                    <div
                        className={cn(
                            'flex items-start gap-2.5 max-w-md rounded-2xl px-4 py-3 border',
                            decorative.length === 0
                                ? 'border-emerald-500/20 bg-emerald-500/[0.06]'
                                : 'border-amber-500/25 bg-amber-500/[0.07]',
                        )}
                    >
                        {decorative.length === 0 ? (
                            <>
                                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                                <p className="text-xs leading-relaxed text-ink-secondary">
                                    <span className="font-semibold text-ink">Every switch is enforced.</span>{' '}
                                    Turning one off doesn't just hide a button — the server refuses the call.
                                </p>
                            </>
                        ) : (
                            <>
                                <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                <p className="text-xs leading-relaxed text-ink-secondary">
                                    <span className="font-semibold text-ink">
                                        {decorative.length}{' '}
                                        {decorative.length === 1 ? 'switch is' : 'switches are'} not enforced.
                                    </span>{' '}
                                    Turning {decorative.length === 1 ? 'it' : 'them'} off hides the control, but
                                    the endpoint still answers.
                                </p>
                            </>
                        )}
                    </div>
                </div>

                {/* One segment per feature. A wall of green is a healthy deployment; anything else
                    is a question, and it is answerable by clicking. */}
                <div className="mt-6 flex gap-1" role="list" aria-label="Feature status">
                    {withState.map(({ feature, state }) => (
                        <button
                            key={feature.key}
                            type="button"
                            role="listitem"
                            onClick={() => onSelect(feature.key)}
                            title={`${feature.name} — ${LEGEND.find(l => l.state === state)?.label}`}
                            aria-label={`${feature.name}: ${LEGEND.find(l => l.state === state)?.label}`}
                            className={cn(
                                'h-2.5 flex-1 rounded-full transition-all duration-200',
                                'hover:h-3.5 hover:-mt-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
                                SEGMENT[state],
                            )}
                        />
                    ))}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                    {LEGEND.map(({ state, label }) => (
                        <span key={state} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                            <span className={cn('w-2 h-2 rounded-full', SEGMENT[state])} />
                            {label}
                        </span>
                    ))}
                </div>
            </div>

            {(restricted.length > 0 || doingNothing.length > 0) && (
                <div className="border-t border-glass-border divide-y divide-glass-border">
                    {restricted.length > 0 && (
                        <Callout
                            tone="warning"
                            title={`Your users cannot ${restricted.length === 1 ? 'do this' : 'do these'} right now`}
                            items={restricted.map(r => r.feature)}
                            onSelect={onSelect}
                        />
                    )}
                    {doingNothing.length > 0 && (
                        <Callout
                            tone="muted"
                            title="Switched on, but having no effect"
                            hint="Something they depend on is turned off."
                            items={doingNothing.map(r => r.feature)}
                            onSelect={onSelect}
                        />
                    )}
                </div>
            )}
        </section>
    )
}

function Callout({
    tone,
    title,
    hint,
    items,
    onSelect,
}: {
    tone: 'warning' | 'muted'
    title: string
    hint?: string
    items: FeatureDefinition[]
    onSelect: (key: string) => void
}) {
    return (
        <div className={cn('px-6 sm:px-8 py-4', tone === 'warning' && 'bg-amber-500/[0.05]')}>
            <p className="text-xs font-semibold text-ink">
                {title}
                {hint && <span className="ml-1.5 font-normal text-ink-muted">{hint}</span>}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
                {items.map(f => (
                    <button
                        key={f.key}
                        type="button"
                        onClick={() => onSelect(f.key)}
                        className={cn(
                            'px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors',
                            tone === 'warning'
                                ? 'border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/15'
                                : 'border-glass-border text-ink-muted hover:text-ink hover:border-ink-muted/40',
                        )}
                    >
                        {f.name}
                    </button>
                ))}
            </div>
        </div>
    )
}
