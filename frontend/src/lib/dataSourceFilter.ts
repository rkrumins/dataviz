/**
 * Narrowing a workspace's data sources: by words (in the name, the description or a tag),
 * by tag, by sensitivity and by trust status. Pure, so the Sources grid and its tests read
 * the same rule.
 */
import type { DataSourceResponse } from '@/services/workspaceService'
import type { Classification, TrustStatus } from '@/services/dataSourceMetadataService'
import { foldTag } from './tags'

export interface DataSourceFilter {
    text: string
    tag: string | null
    classification: Classification | null
    trustStatus: TrustStatus | null
}

export const NO_FILTER: DataSourceFilter = { text: '', tag: null, classification: null, trustStatus: null }

type Filterable = Pick<DataSourceResponse, 'label' | 'description' | 'catalogDescription' | 'tags' | 'classification' | 'trustStatus'>

export const isFiltering = (f: DataSourceFilter) => !!(f.text.trim() || f.tag || f.classification || f.trustStatus)

/** Worth a filter bar: more than a screenful of sources, or any of them tagged. */
export const wantsFilterBar = (sources: readonly Filterable[]) =>
    sources.length > 6 || sources.some(s => (s.tags ?? []).length > 0)

/** The sources that match every part of the filter. `nameOf` names a source that has no
 *  label of its own (the catalog item's name), so words find it too. */
export function filterDataSources<T extends Filterable>(sources: readonly T[], f: DataSourceFilter, nameOf?: (s: T) => string | undefined): T[] {
    const words = f.text.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const tag = f.tag ? foldTag(f.tag) : null
    return sources.filter(s => {
        const tags = (s.tags ?? []).map(foldTag)
        if (tag && !tags.includes(tag)) return false
        if (f.classification && s.classification !== f.classification) return false
        if (f.trustStatus && s.trustStatus !== f.trustStatus) return false
        if (words.length === 0) return true
        const hay = [s.label || nameOf?.(s) || '', s.description || s.catalogDescription || '', ...tags].join('\n').toLocaleLowerCase()
        return words.every(w => hay.includes(w))
    })
}
