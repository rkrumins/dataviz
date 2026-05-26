/**
 * "How to show it" card — surfaces the per-request options inline
 * rather than burying them in a chevron-down disclosure.
 *
 * Reads ``searchStore.draftOptions`` (falling back to defaults when
 * null) and writes through ``setDraftOptions``. Templates supply their
 * own options via ``SearchTemplate.build`` and ignore this card.
 *
 * Layout: a 2-row grid. Top row is the headline "Group by" control
 * since that's the option that most directly shapes the result
 * narrative. Page-size / candidate-cap / include-ancestor-path sit
 * underneath as advanced affordances.
 */
import { type FC, useState } from 'react'

import { cn } from '@/lib/utils'
import {
    DEFAULT_DRAFT_OPTIONS,
    useDraftOptions,
    useSearchStore,
} from '@/store/searchStore'

import { AggregationEditor } from './AggregationEditor'


export interface OptionsPanelProps {
    knownEntityTypes: string[]
    knownPropertyKeys: string[]
}


export const OptionsPanel: FC<OptionsPanelProps> = ({
    knownEntityTypes, knownPropertyKeys,
}) => {
    const draftOptions = useDraftOptions()
    const setDraftOptions = useSearchStore((s) => s.setDraftOptions)
    const effective = draftOptions ?? DEFAULT_DRAFT_OPTIONS
    const isCustom = draftOptions !== null
    const [showAdvanced, setShowAdvanced] = useState(false)

    const primarySpec = effective.aggregations[0] ?? { by: 'entityType', maxBuckets: 50 }

    return (
        <div className="flex flex-col gap-2.5">
            {isCustom && (
                <button
                    type="button"
                    onClick={() => setDraftOptions(null)}
                    className={cn(
                        "self-end inline-flex items-center gap-1 px-2 py-1 rounded-md",
                        "text-[10.5px] font-medium text-ink-muted hover:text-ink",
                        "hover:bg-glass/40 transition-colors",
                    )}
                >
                    Reset defaults
                </button>
            )}

            <div className="rounded-2xl border border-glass-border bg-canvas-base/30 p-3.5 flex flex-col gap-3">
                <AggregationEditor
                    value={primarySpec}
                    knownEntityTypes={knownEntityTypes}
                    knownPropertyKeys={knownPropertyKeys}
                    onChange={(next) => setDraftOptions({ aggregations: [next] })}
                />

                <button
                    type="button"
                    onClick={() => setShowAdvanced((v) => !v)}
                    className={cn(
                        "self-start text-[10.5px] text-ink-muted hover:text-ink underline decoration-dotted",
                    )}
                >
                    {showAdvanced ? 'Hide' : 'Show'} advanced options
                </button>

                {showAdvanced && (
                    <div className="flex flex-col gap-3 pt-2 border-t border-glass-border/40">
                        <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                                    Page size
                                </span>
                                <input
                                    type="number"
                                    min={1}
                                    max={500}
                                    value={effective.pageSize}
                                    onChange={(e) => setDraftOptions({
                                        pageSize: Math.max(1, Math.min(500, Number(e.target.value) || 50)),
                                    })}
                                    className={cn(
                                        "px-2 py-1 rounded-md tabular-nums",
                                        "bg-canvas-base/40 border border-glass-border",
                                        "text-xs text-ink text-right",
                                        "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                                    )}
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                                    Candidate cap
                                </span>
                                <input
                                    type="number"
                                    min={100}
                                    max={50000}
                                    step={500}
                                    value={effective.candidateCap}
                                    onChange={(e) => setDraftOptions({
                                        candidateCap: Math.max(100, Math.min(50000, Number(e.target.value) || 5000)),
                                    })}
                                    className={cn(
                                        "px-2 py-1 rounded-md tabular-nums",
                                        "bg-canvas-base/40 border border-glass-border",
                                        "text-xs text-ink text-right",
                                        "focus:outline-none focus:ring-2 focus:ring-accent-lineage/40",
                                    )}
                                />
                            </label>
                        </div>

                        <label className="flex items-start gap-2 text-[11px] text-ink-muted">
                            <input
                                type="checkbox"
                                checked={effective.includeAncestorPath}
                                onChange={(e) => setDraftOptions({ includeAncestorPath: e.target.checked })}
                                className="mt-0.5 rounded border-glass-border"
                            />
                            <span>
                                <span className="text-ink">Include ancestor path on each hit</span>
                                <span className="block text-[10px] text-ink-muted/70 leading-snug">
                                    Required for canvas reveal + roll-up; turn off only if you don't need it.
                                </span>
                            </span>
                        </label>
                    </div>
                )}
            </div>
        </div>
    )
}
