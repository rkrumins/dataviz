/**
 * The section's small vocabularies: how a change was made, where a category's section is, and what
 * a workspace's graph is called.
 */
import type { ChangeSource, WorkspaceGraph } from '@/services/settingsService'

/** How a change set was made. */
export const SOURCE_LABEL: Record<ChangeSource, string> = {
    api: 'Saved in settings',
    legacy_api: 'Saved through the old settings',
    migration: 'Carried over when settings moved here',
    revert: 'Put back',
}

/** The anchor of a category's section. */
export const categoryAnchor = (id: string) => `category-${id}`

/** What a workspace's graph is called: its data source's name, else its id. */
export const graphName = (g: WorkspaceGraph) => g.label ?? g.dataSourceId ?? g.graphId
