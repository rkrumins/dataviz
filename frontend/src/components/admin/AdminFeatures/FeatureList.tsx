/**
 * All twelve features, at once, in a column you can read without scrolling.
 *
 * The grid this replaces was spending a full screen of vertical scroll on twelve items: six
 * category headings, each followed by a single card in a three-column grid, so most of the page was
 * the empty space beside a lone tile. The information density was near zero and the shape of the
 * product was invisible — you could not see "these are my features" in one look, which is the
 * entire job of an index.
 *
 * The categories survive as quiet dividers rather than sections. They group; they no longer cost a
 * screen each.
 *
 * Each row carries the one line that says what the feature IS, plus its state — and the toggle,
 * because the common case is flipping something you already understand, and making that a two-click
 * journey through a detail pane would be worse, not better.
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
    inert: 'bg-ink-muted/50',
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
        <nav className="rounded-3xl border border-glass-border bg-canvas-elevated overflow-hidden">
            {grouped.map(([categoryId, features], groupIndex) => (
                <div key={categoryId}>
                    <p
                        className={cn(
                            'px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted',
                            'bg-black/[0.02] dark:bg-white/[0.02] border-glass-border',
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
                                    'relative flex items-start gap-3 pl-4 pr-3 py-3 border-b border-glass-border last:border-b-0 transition-colors',
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
                                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 rounded-lg"
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
                                        {/* A switch that isn't enforced is decoration. Say so where
                                            someone is about to trust it. */}
                                        {feature.enforcedServerSide !== true && (
                                            <ShieldAlert
                                                className="w-3 h-3 text-amber-500 shrink-0"
                                                aria-label="Not enforced by the server"
                                            />
                                        )}
                                    </span>

                                    <span className="mt-0.5 block pl-3.5 text-[11px] leading-snug text-ink-muted line-clamp-2">
                                        {state === 'off' && feature.impactWhenOff
                                            ? feature.impactWhenOff
                                            : feature.description}
                                    </span>
                                </button>

                                <div className="shrink-0 flex items-center gap-2 pt-0.5">
                                    {savingKey === feature.key && (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" />
                                    )}
                                    {count ? (
                                        <button
                                            type="button"
                                            onClick={() => onSelect(feature.key)}
                                            className="px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-secondary bg-black/[0.04] dark:bg-white/[0.06] border border-glass-border hover:text-ink transition-colors"
                                        >
                                            {count}
                                        </button>
                                    ) : (
                                        <ToggleSwitch
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
