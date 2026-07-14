/**
 * All twelve features, in a column you can run your eye down.
 *
 * The first cut of this let each row be as tall as its description wanted to be, so "Self-
 * registration" was a six-line paragraph sitting between two two-line rows. That is not an index —
 * an index has UNIFORM rows, because the whole point is that your eye can travel down it without
 * stopping to read. Descriptions are clamped to one line here; the full text is in the spec pane a
 * few centimetres away, which is where you go when a name makes you curious.
 *
 * A row shows the description normally, and the CONSEQUENCE when the feature is off — that is the
 * sentence that matters in that state, and it's the one you want while scanning for what your users
 * have lost.
 */
import { Loader2, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToggleSwitch } from './ToggleSwitch'
import type { FeatureCategory, FeatureDefinition } from '@/services/featuresService'
import { isOn, selectionLabel, stateOf, type FeatureState } from './featureState'

const DOT: Record<FeatureState, string> = {
    on: 'bg-emerald-500',
    partial: 'bg-sky-500',
    off: 'bg-amber-500',
    // Grey at 40% on a dark canvas is invisible — the old legend proved it. This one has to be seen.
    inert: 'bg-ink-muted',
}

export function FeatureList({
    grouped,
    categoryMetaById,
    allFeatures,
    values,
    selectedKey,
    savingKey,
    onSelect,
    onToggle,
}: {
    /** [categoryId, features] in display order. */
    grouped: [string, FeatureDefinition[]][]
    categoryMetaById: Record<string, FeatureCategory>
    allFeatures: FeatureDefinition[]
    values: Record<string, unknown>
    selectedKey: string | null
    savingKey: string | null
    onSelect: (key: string) => void
    onToggle: (feature: FeatureDefinition, next: boolean) => void
}) {
    return (
        <nav>
            {grouped.map(([categoryId, features], groupIndex) => (
                <div key={categoryId}>
                    <p
                        className={cn(
                            'sticky top-0 z-10 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted',
                            'bg-canvas-elevated/95 backdrop-blur border-glass-border',
                            groupIndex === 0 ? 'border-b' : 'border-y',
                        )}
                    >
                        {categoryMetaById[categoryId]?.label ?? categoryId}
                    </p>

                    {features.map(feature => {
                        const state = stateOf(feature, allFeatures, values)
                        const selected = feature.key === selectedKey
                        const on = isOn(feature, values)
                        const count = selectionLabel(feature, values)

                        return (
                            <div
                                key={feature.key}
                                className={cn(
                                    'relative flex items-center gap-3 pl-4 pr-3 border-b border-glass-border last:border-b-0 transition-colors',
                                    selected
                                        ? 'bg-indigo-500/[0.07]'
                                        : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                )}
                            >
                                {selected && (
                                    <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-accent-lineage" />
                                )}

                                <button
                                    type="button"
                                    onClick={() => onSelect(feature.key)}
                                    className="min-w-0 flex-1 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/60"
                                    aria-current={selected}
                                >
                                    <span className="flex items-center gap-2">
                                        <span
                                            className={cn('w-1.5 h-1.5 rounded-full shrink-0', DOT[state])}
                                            aria-hidden
                                        />
                                        <span
                                            className={cn(
                                                'text-sm font-semibold truncate',
                                                selected ? 'text-ink' : 'text-ink-secondary',
                                            )}
                                        >
                                            {feature.name}
                                        </span>
                                        {/* A switch nobody enforces is decoration. Say so where someone
                                            is about to trust it. */}
                                        {feature.enforcedServerSide !== true && (
                                            <ShieldAlert
                                                className="w-3 h-3 text-amber-500 shrink-0"
                                                aria-label="Not enforced by the server"
                                            />
                                        )}
                                    </span>

                                    <span
                                        className={cn(
                                            'mt-0.5 block pl-3.5 text-[11px] leading-snug truncate',
                                            state === 'off'
                                                ? 'text-amber-700/90 dark:text-amber-300/80'
                                                : 'text-ink-muted',
                                        )}
                                    >
                                        {state === 'off' && feature.impactWhenOff
                                            ? feature.impactWhenOff
                                            : feature.description}
                                    </span>
                                </button>

                                <div className="shrink-0 flex items-center gap-1.5">
                                    {savingKey === feature.key && (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" />
                                    )}
                                    {count ? (
                                        <button
                                            type="button"
                                            onClick={() => onSelect(feature.key)}
                                            className="px-2 py-1 rounded-lg text-[11px] font-semibold tabular-nums text-ink-secondary bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border hover:text-ink transition-colors"
                                        >
                                            {count}
                                        </button>
                                    ) : (
                                        <ToggleSwitch
                                            size="sm"
                                            checked={on}
                                            onChange={next => onToggle(feature, next)}
                                            disabled={savingKey === feature.key}
                                            aria-label={`Turn ${feature.name} ${on ? 'off' : 'on'}`}
                                        />
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            ))}
        </nav>
    )
}
