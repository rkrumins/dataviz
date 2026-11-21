/**
 * Above the Sources grid, once there are enough sources or any are tagged: find one by
 * words (its name, description or tags), or narrow the grid to a tag, a sensitivity or a
 * trust status. Clicking a tag on a card sets the tag here.
 */
import { useMemo } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { countTags, foldTag } from '@/lib/tags'
import { isFiltering, NO_FILTER, type DataSourceFilter } from '@/lib/dataSourceFilter'
import {
    CLASSIFICATIONS, CLASSIFICATION_LABEL, TRUST_LABEL, TRUST_STATUSES, type Classification, type TrustStatus,
} from '@/services/dataSourceMetadataService'
import type { DataSourceResponse } from '@/services/workspaceService'

const SELECT = 'h-9 min-w-0 rounded-xl border px-2.5 text-xs font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
const IDLE = 'border-glass-border bg-black/[0.03] text-ink-secondary hover:text-ink dark:bg-white/[0.04]'
const SET = 'border-accent-lineage/40 bg-accent-lineage/[0.08] text-accent-lineage'

export function DataSourceFilterBar({ sources, filter, onChange, shown }: {
    sources: readonly DataSourceResponse[]
    filter: DataSourceFilter
    onChange: (f: DataSourceFilter) => void
    /** How many match, for "2 of 9". */
    shown: number
}) {
    const tags = useMemo(() => countTags(sources.map(s => s.tags)), [sources])
    // The tag a card was clicked on may be spelled differently from the one listed.
    const tagValue = filter.tag ? (tags.find(t => foldTag(t.tag) === foldTag(filter.tag!))?.tag ?? filter.tag) : ''
    const filtering = isFiltering(filter)

    return (
        <div role="search" aria-label="Filter the sources"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-glass-border bg-canvas-elevated p-2 shadow-sm">
            <label className="relative min-w-[200px] flex-1">
                <span className="sr-only">Find a source</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden />
                <input type="search" value={filter.text} onChange={e => onChange({ ...filter, text: e.target.value })}
                    placeholder="Find a source by name, description or tag"
                    className="h-9 w-full rounded-xl border border-transparent bg-black/[0.03] pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted/70 outline-none focus:border-accent-lineage/40 focus:ring-2 focus:ring-accent-lineage/30 dark:bg-white/[0.04]" />
            </label>
            {tags.length > 0 && (
                <select aria-label="Tag" value={tagValue} onChange={e => onChange({ ...filter, tag: e.target.value || null })}
                    className={cn(SELECT, filter.tag ? SET : IDLE)}>
                    <option value="">Any tag</option>
                    {tags.map(t => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
                </select>
            )}
            <select aria-label="Sensitivity" value={filter.classification ?? ''}
                onChange={e => onChange({ ...filter, classification: (e.target.value || null) as Classification | null })}
                className={cn(SELECT, filter.classification ? SET : IDLE)}>
                <option value="">Any sensitivity</option>
                {CLASSIFICATIONS.map(c => <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>)}
            </select>
            <select aria-label="Status" value={filter.trustStatus ?? ''}
                onChange={e => onChange({ ...filter, trustStatus: (e.target.value || null) as TrustStatus | null })}
                className={cn(SELECT, filter.trustStatus ? SET : IDLE)}>
                <option value="">Any status</option>
                {TRUST_STATUSES.map(s => <option key={s} value={s}>{TRUST_LABEL[s]}</option>)}
            </select>
            {filtering && (
                <span className="flex items-center gap-2 pl-1">
                    <span aria-live="polite" className="text-xs tabular-nums text-ink-muted">{shown} of {sources.length}</span>
                    <button type="button" onClick={() => onChange(NO_FILTER)}
                        className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold text-ink-secondary hover:bg-black/[0.04] hover:text-ink dark:hover:bg-white/[0.06]">
                        <X className="h-3.5 w-3.5" aria-hidden /> Clear
                    </button>
                </span>
            )}
        </div>
    )
}
