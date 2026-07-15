/**
 * How much of your product is switched on — and exactly what your users have lost.
 *
 * THE BAR PLOTS SOMETHING DIFFERENT NOW, and that's the whole fix.
 *
 * The first version drew ONE SEGMENT PER FEATURE: twelve identical bars, coloured by state. It
 * looked like a chart, but you couldn't tell which bar was which feature without hovering a native
 * tooltip — so the only thing you could actually read off it was a count you already had from the
 * sentence beside it. A picture of data instead of data.
 *
 * (The proof nobody could read it: its legend carried a fourth entry, "No effect", whose dot was
 * grey-on-dark at 40% opacity and therefore invisible. It shipped, sat on screen, and neither of us
 * noticed.)
 *
 * So it plots STATE now, not features: one segment per state, WIDTH PROPORTIONAL TO HOW MANY
 * FEATURES ARE IN IT. That is a claim you can read in one look — "nearly all green, a sliver of
 * amber" — and it's the actual shape of the question: how much of my product is available? The
 * legend carries the counts, only shows states that exist, and every part of it is clickable,
 * because the thing you want after seeing a sliver of amber is the feature inside it.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FeatureDefinition } from '@/services/featuresService'
import { stateOf, type FeatureState } from './featureState'

const BAND: Record<FeatureState, { bar: string; dot: string; label: string; hint: string }> = {
    on: {
        bar: 'bg-emerald-500',
        dot: 'bg-emerald-500',
        label: 'Available',
        hint: 'Working, and available to everyone with permission.',
    },
    partial: {
        bar: 'bg-sky-500',
        dot: 'bg-sky-500',
        label: 'Limited',
        hint: 'On, but you have withdrawn some of its options.',
    },
    off: {
        bar: 'bg-amber-500',
        dot: 'bg-amber-500',
        label: 'Turned off',
        hint: 'Your users cannot do this at all.',
    },
    inert: {
        bar: 'bg-ink-muted',
        dot: 'bg-ink-muted',
        label: 'No effect',
        hint: 'Switched on, but something it depends on is off — so it does nothing.',
    },
}

/** The order the bands stack, left to right — best state first, so the bar reads as a fuel gauge. */
const ORDER: FeatureState[] = ['on', 'partial', 'off', 'inert']

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

    const byState = new Map<FeatureState, FeatureDefinition[]>()
    for (const f of live) {
        const state = stateOf(f, live, values)
        byState.set(state, [...(byState.get(state) ?? []), f])
    }

    /** Only the states that actually exist. A legend entry for a band with nothing in it is noise. */
    const bands = ORDER
        .map(state => ({ state, items: byState.get(state) ?? [] }))
        .filter(b => b.items.length > 0)

    const available = (byState.get('on')?.length ?? 0) + (byState.get('partial')?.length ?? 0)
    const restricted = byState.get('off') ?? []
    const doingNothing = byState.get('inert') ?? []

    // Computed from the code (config/feature_wiring.py), never asserted by hand. If a decorative
    // switch ever reappears, this page says so rather than presenting it as real.
    const decorative = live.filter(f => f.enforcedServerSide !== true)

    return (
        <section className="mb-6 rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
            <div className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
                    <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                            This deployment
                        </p>
                        <p className="mt-1 text-2xl font-bold tracking-tight text-ink">
                            {available} of {live.length}{' '}
                            <span className="text-ink-muted font-semibold">features available to your users</span>
                        </p>
                    </div>

                    <div className="flex items-start gap-2 max-w-sm">
                        {decorative.length === 0 ? (
                            <>
                                <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                                <p className="text-xs text-ink-muted leading-relaxed">
                                    <span className="font-medium text-ink-secondary">Every switch is enforced.</span>{' '}
                                    Turning one off doesn't just hide a button — the server refuses the call.
                                </p>
                            </>
                        ) : (
                            <>
                                <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                <p className="text-xs text-ink-muted leading-relaxed">
                                    <span className="font-medium text-ink-secondary">
                                        {decorative.length}{' '}
                                        {decorative.length === 1 ? 'switch is' : 'switches are'} not enforced.
                                    </span>{' '}
                                    Turning {decorative.length === 1 ? 'it' : 'them'} off hides the control, but the
                                    endpoint still answers.
                                </p>
                            </>
                        )}
                    </div>
                </div>

                {/* ONE BAR. Bands sized by how many features are in them, so the picture IS the
                    proportion — not twelve anonymous ticks you have to hover to identify. */}
                <div
                    className="mt-4 flex gap-1 h-2.5"
                    role="img"
                    aria-label={bands
                        .map(b => `${b.items.length} ${BAND[b.state].label.toLowerCase()}`)
                        .join(', ')}
                >
                    {bands.map(({ state, items }) => (
                        <button
                            key={state}
                            type="button"
                            onClick={() => onSelect(items[0].key)}
                            style={{ flexGrow: items.length }}
                            title={`${items.length} ${BAND[state].label.toLowerCase()} — ${items
                                .map(f => f.name)
                                .join(', ')}`}
                            className={cn(
                                'rounded-full transition-opacity hover:opacity-80',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
                                BAND[state].bar,
                            )}
                        />
                    ))}
                </div>

                {/* The legend IS the summary: a count, a meaning, and a way in. */}
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
                    {bands.map(({ state, items }) => (
                        <button
                            key={state}
                            type="button"
                            onClick={() => onSelect(items[0].key)}
                            title={BAND[state].hint}
                            className="group inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink transition-colors"
                        >
                            <span className={cn('w-2 h-2 rounded-full shrink-0', BAND[state].dot)} />
                            <span className="font-semibold tabular-nums text-ink-secondary group-hover:text-ink">
                                {items.length}
                            </span>
                            {BAND[state].label}
                        </button>
                    ))}
                </div>
            </div>

            {/* The names. A count tells you how bad it is; a name tells you what to do about it. */}
            {restricted.length > 0 && (
                <Row
                    tone="warning"
                    label={
                        restricted.length === 1
                            ? 'Your users cannot:'
                            : `Your users cannot do ${restricted.length} of these:`
                    }
                    items={restricted}
                    onSelect={onSelect}
                />
            )}

            {doingNothing.length > 0 && (
                <Row
                    tone="muted"
                    label="On, but having no effect:"
                    items={doingNothing}
                    onSelect={onSelect}
                />
            )}
        </section>
    )
}

function Row({
    tone,
    label,
    items,
    onSelect,
}: {
    tone: 'warning' | 'muted'
    label: string
    items: FeatureDefinition[]
    onSelect: (key: string) => void
}) {
    return (
        <div
            className={cn(
                'flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 border-t border-glass-border',
                tone === 'warning' ? 'bg-amber-500/[0.05]' : 'bg-black/[0.02] dark:bg-white/[0.02]',
            )}
        >
            <span className="text-xs font-semibold text-ink shrink-0">{label}</span>
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
    )
}
