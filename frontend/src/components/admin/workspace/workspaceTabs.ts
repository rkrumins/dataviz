/**
 * The workspace page's tabs, and where an older link lands.
 *
 * The page used to have eight flat tabs named after the machinery (Data Sources,
 * Profiling, Aggregation, Ontology…). They are grouped now: what a workspace is
 * for comes first (Overview, Views), the data behind it sits under one Data tab
 * with its own sections, and configuration has a Settings tab of its own.
 *
 * Links written for the old tabs live on — in notifications the server sent, in
 * bookmarks, in other pages — so every old `?tab=` still lands on the right
 * place: `?tab=aggregation` opens Data → Processing, and so on.
 */

export type WorkspaceTab =
    | 'overview' | 'views' | 'data' | 'reviews' | 'members' | 'activity' | 'settings'

export type DataSection = 'sources' | 'model' | 'processing' | 'trends'

const TABS: readonly WorkspaceTab[] = ['overview', 'views', 'data', 'reviews', 'members', 'activity', 'settings']
const SECTIONS: readonly DataSection[] = ['sources', 'model', 'processing', 'trends']

/** The old tabs that are now sections of Data. */
const LEGACY_DATA_TABS: Record<string, DataSection> = {
    sources: 'sources',
    ontology: 'model',
    aggregation: 'processing',
    profiling: 'trends',
}

export interface WorkspaceLocation {
    tab: WorkspaceTab
    section: DataSection
}

/**
 * Where `?tab=` and `?section=` (and `?ds=`) put the reader. No tab is the
 * Overview — unless the link opens a data source, which belongs to Data.
 */
export function normalizeWorkspaceTab(
    tab: string | null,
    section: string | null,
    opts: { hasDataSource?: boolean } = {},
): WorkspaceLocation {
    const sectionOf = (s: string | null): DataSection =>
        s && (SECTIONS as readonly string[]).includes(s) ? (s as DataSection) : 'sources'
    if (tab && tab in LEGACY_DATA_TABS) return { tab: 'data', section: LEGACY_DATA_TABS[tab] }
    if (tab && (TABS as readonly string[]).includes(tab)) return { tab: tab as WorkspaceTab, section: sectionOf(section) }
    if (opts.hasDataSource) return { tab: 'data', section: 'sources' }
    return { tab: 'overview', section: sectionOf(section) }
}

/** The address for a place on the page: Overview writes no tab, Sources no section. */
export function workspaceTabParams(loc: WorkspaceLocation): { tab: string | null; section: string | null } {
    return {
        tab: loc.tab === 'overview' ? null : loc.tab,
        section: loc.tab === 'data' && loc.section !== 'sources' ? loc.section : null,
    }
}
