/**
 * Every link written for the workspace page's old tabs still lands where it meant:
 * the server's notifications (`?tab=views`, `?tab=members`), a data source's link
 * (`?ds=…&dstab=…`), and the tabs that are now sections of Data.
 */
import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceTab, workspaceTabParams } from '../workspaceTabs'

describe('normalizeWorkspaceTab', () => {
    it('opens on the Overview with no tab', () => {
        expect(normalizeWorkspaceTab(null, null)).toEqual({ tab: 'overview', section: 'sources' })
    })

    it.each([
        ['sources', 'sources'],
        ['ontology', 'model'],
        ['aggregation', 'processing'],
        ['profiling', 'trends'],
    ])('sends the old %s tab to Data → %s', (tab, section) => {
        expect(normalizeWorkspaceTab(tab, null)).toEqual({ tab: 'data', section })
    })

    it.each(['views', 'members', 'reviews', 'activity', 'settings'])('keeps %s as it was', (tab) => {
        expect(normalizeWorkspaceTab(tab, null).tab).toBe(tab)
    })

    it('reads a Data section, and falls back to Sources for one it does not know', () => {
        expect(normalizeWorkspaceTab('data', 'processing')).toEqual({ tab: 'data', section: 'processing' })
        expect(normalizeWorkspaceTab('data', 'nope')).toEqual({ tab: 'data', section: 'sources' })
    })

    it('opens Data when a link names a data source but no tab', () => {
        expect(normalizeWorkspaceTab(null, null, { hasDataSource: true })).toEqual({ tab: 'data', section: 'sources' })
        // An explicit tab still wins.
        expect(normalizeWorkspaceTab('views', null, { hasDataSource: true }).tab).toBe('views')
    })

    it('treats an unknown tab as no tab', () => {
        expect(normalizeWorkspaceTab('bogus', null).tab).toBe('overview')
    })
})

describe('workspaceTabParams', () => {
    it('writes no tab for the Overview and no section for Sources', () => {
        expect(workspaceTabParams({ tab: 'overview', section: 'sources' })).toEqual({ tab: null, section: null })
        expect(workspaceTabParams({ tab: 'data', section: 'sources' })).toEqual({ tab: 'data', section: null })
        expect(workspaceTabParams({ tab: 'data', section: 'model' })).toEqual({ tab: 'data', section: 'model' })
        expect(workspaceTabParams({ tab: 'views', section: 'model' })).toEqual({ tab: 'views', section: null })
    })
})
