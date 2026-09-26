/**
 * useEntityEditing — an edit to an entity is kept only as a change in a draft,
 * so a surface offers one only where a draft of this view is open. Anywhere
 * else it says why: the data source has no version control (an external
 * graph is read-only here), or no draft is open yet.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBranchStore } from '@/store/branchStore'

import { NO_DRAFT, NO_VERSION_CONTROL, useEntityEditing } from '../useEntityEditing'


let flags: Record<string, boolean>
let readOnly: boolean
let resolve: { data?: { graphId: string; bootstrap?: unknown }; isError: boolean }

vi.mock('@/store/features', () => ({ useFeature: (key: string) => flags[key] ?? false }))
vi.mock('@/store/schema', () => ({
    useActiveView: () => ({ id: 'view-1', workspaceId: 'ws', dataSourceId: 'ds' }),
}))
vi.mock('@/providers/ViewExecutionContext', () => ({
    useViewExecutionContext: () => ({ readOnly }),
}))
vi.mock('../useVersioning', () => ({ useResolveGraph: () => resolve }))

const VERSIONED = { data: { graphId: 'g1' }, isError: false }

function inDraftOf(viewId: string) {
    useBranchStore.setState({
        workspaceId: 'ws', dataSourceId: 'ds', viewId, currentBranchId: 'br_1', mainBranchId: 'br_main',
    })
}

beforeEach(() => {
    flags = { versioningEnabled: true, editModeEnabled: true }
    readOnly = false
    resolve = VERSIONED
    useBranchStore.getState().reset()
})


describe('useEntityEditing', () => {
    it('lets an entity be edited while a draft of this view is open', () => {
        inDraftOf('view-1')
        const { result } = renderHook(() => useEntityEditing())
        expect(result.current).toEqual({ offered: true, blocked: null })
    })

    it('asks for a draft on a versioned source with none open', () => {
        const { result } = renderHook(() => useEntityEditing())
        expect(result.current).toEqual({ offered: true, blocked: NO_DRAFT })
    })

    it("does not take another view's draft as this view's", () => {
        inDraftOf('view-2')
        const { result } = renderHook(() => useEntityEditing())
        expect(result.current.blocked).toBe(NO_DRAFT)
    })

    it('says a data source without version control cannot be edited', () => {
        resolve = { isError: true }
        const { result } = renderHook(() => useEntityEditing())
        expect(result.current).toEqual({ offered: true, blocked: NO_VERSION_CONTROL })
    })

    it('says so while version control is still being set up', () => {
        resolve = { data: { graphId: 'g1', bootstrap: { status: 'running' } }, isError: false }
        const { result } = renderHook(() => useEntityEditing())
        expect(result.current.blocked).toBe(NO_VERSION_CONTROL)
    })

    it.each([
        ['edit mode is off', () => { flags.editModeEnabled = false }],
        ['version control is off', () => { flags.versioningEnabled = false }],
        ['the view is read-only for this person', () => { readOnly = true }],
    ])('offers no editing at all when %s', (_, arrange) => {
        inDraftOf('view-1')
        arrange()
        const { result } = renderHook(() => useEntityEditing())
        expect(result.current.offered).toBe(false)
    })
})
