/**
 * PropertyBrowser — read-only catalogue of the property keys, values and
 * tags in use across the current view, sourced entirely from the
 * Advanced-Search discovery endpoint (``useDiscovery``).
 *
 * For each property key it surfaces:
 *   - which entity types carry it (usage),
 *   - a few sample values.
 * Tags are listed separately (they're a distinct facet in discovery).
 *
 * "Tag matches" on a key/value seeds a new display rule pre-filled with
 * the corresponding predicate, handing off to the Display Rules tab.
 */
import { Loader2, Plus, Search, Tag } from 'lucide-react'
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import type { Predicate } from '@/types/search'

import { useDiscovery } from '../search/builder/useDiscovery'
import { fieldClass } from '../search/builder/editors/shared'


export interface PropertyBrowserProps {
    viewId: string
    /** Seed a new display rule from a discovered property / tag. */
    onCreateRuleFromPredicate: (predicate: Predicate, suggestedName: string) => void
}


export function PropertyBrowser({ viewId, onCreateRuleFromPredicate }: PropertyBrowserProps) {
    const {
        allKeys, keysByEntityType, tagValues, getValueSamples, isInitialLoading, error,
    } = useDiscovery(viewId)
    const [query, setQuery] = useState('')

    // Reverse the per-entity-type map so each key lists the entity types
    // that use it (the "usage" the brief asks for).
    const typesByKey = useMemo(() => {
        const out: Record<string, string[]> = {}
        for (const [entityType, keys] of Object.entries(keysByEntityType)) {
            for (const k of keys) {
                (out[k] ??= []).push(entityType)
            }
        }
        for (const k of Object.keys(out)) out[k].sort()
        return out
    }, [keysByEntityType])

    const q = query.trim().toLowerCase()
    const filteredKeys = useMemo(
        () => (q ? allKeys.filter((k) => k.toLowerCase().includes(q)) : allKeys),
        [allKeys, q],
    )
    const filteredTags = useMemo(
        () => (q ? tagValues.filter((t) => t.toLowerCase().includes(q)) : tagValues),
        [tagValues, q],
    )

    if (isInitialLoading) {
        return (
            <div className="flex items-center gap-2 px-3 py-6 text-[11px] text-ink-muted justify-center">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Discovering properties, values and tags for this view…
            </div>
        )
    }
    if (error) {
        return (
            <div className="px-3 py-4 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300">
                Discovery failed — {error.message}
            </div>
        )
    }
    if (allKeys.length === 0 && tagValues.length === 0) {
        return (
            <div className="px-3 py-6 text-center text-[11px] text-ink-muted">
                No queryable properties or tags were discovered for this view.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Filter */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60" />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter properties and tags…"
                    className={cn(fieldClass, 'pl-9')}
                />
            </div>

            {/* Tags */}
            {filteredTags.length > 0 && (
                <section className="flex flex-col gap-1.5">
                    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted flex items-center gap-1.5">
                        <Tag className="w-3 h-3" /> Tags · {filteredTags.length}
                    </h4>
                    <div className="flex flex-wrap gap-1.5">
                        {filteredTags.map((tag) => (
                            <button
                                key={tag}
                                type="button"
                                onClick={() => onCreateRuleFromPredicate(
                                    { kind: 'tag', op: 'hasAny', values: [tag] },
                                    tag,
                                )}
                                title={`Create a display rule tagging entities with "${tag}"`}
                                className="group inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs bg-accent-lineage/12 text-accent-lineage hover:bg-accent-lineage/22 transition-colors"
                            >
                                {tag}
                                <Plus className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                            </button>
                        ))}
                    </div>
                </section>
            )}

            {/* Property keys */}
            {filteredKeys.length > 0 && (
                <section className="flex flex-col gap-1.5">
                    <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                        Properties · {filteredKeys.length}
                    </h4>
                    <div className="flex flex-col gap-1.5">
                        {filteredKeys.map((key) => (
                            <PropertyRow
                                key={key}
                                propertyKey={key}
                                usedBy={typesByKey[key] ?? []}
                                samples={getValueSamples(key)}
                                onCreateRule={() => onCreateRuleFromPredicate(
                                    { kind: 'hasProperty', key, negate: false },
                                    key,
                                )}
                            />
                        ))}
                    </div>
                </section>
            )}

            {filteredKeys.length === 0 && filteredTags.length === 0 && (
                <div className="px-3 py-5 text-center text-[11px] text-ink-muted">
                    Nothing matches <span className="font-mono text-ink">{query}</span>.
                </div>
            )}
        </div>
    )
}


function PropertyRow({
    propertyKey, usedBy, samples, onCreateRule,
}: {
    propertyKey: string
    usedBy: string[]
    samples: unknown[]
    onCreateRule: () => void
}) {
    const sampleText = useMemo(
        () => samples.slice(0, 4).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))),
        [samples],
    )

    return (
        <div className="group rounded-lg border border-glass-border/60 bg-canvas-base/20 px-3 py-2 hover:border-glass-border transition-colors">
            <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-ink truncate" title={propertyKey}>
                    {propertyKey}
                </span>
                <button
                    type="button"
                    onClick={onCreateRule}
                    title={`Create a display rule from "${propertyKey}"`}
                    className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-accent-lineage opacity-0 group-hover:opacity-100 hover:bg-accent-lineage/15 transition-all"
                >
                    <Plus className="w-3 h-3" /> Rule
                </button>
            </div>
            {usedBy.length > 0 && (
                <div className="mt-1 text-[10px] text-ink-muted/80 truncate">
                    Used by: {usedBy.join(', ')}
                </div>
            )}
            {sampleText.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                    {sampleText.map((v, i) => (
                        <span
                            key={i}
                            className="px-1.5 py-0.5 rounded bg-glass/40 text-[10px] text-ink-muted font-mono truncate max-w-[140px]"
                            title={v}
                        >
                            {v}
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}
