/**
 * The delete dialog's job is to tell the truth about what is about to happen.
 *
 * These pin the four ways it previously lied or over-charged:
 *   1. it never mentioned the version history at all;
 *   2. a FAILED impact probe rendered as the green "safe to delete" panel;
 *   3. it reassured people about graph data we were in fact about to drop;
 *   4. it demanded a type-to-confirm for an action that is now reversible — friction that
 *      teaches people to stop reading the dialog, spent on the one that costs nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
    impactSections, deleteCaveat, useDataSourceDeletion,
} from '../useDataSourceDeletion'
import type { WorkspaceDataSourceImpactResponse } from '@/services/workspaceService'

vi.mock('@/services/workspaceService', () => ({
    workspaceService: {
        getDataSourceImpact: vi.fn(),
        removeDataSource: vi.fn(),
        restoreDataSource: vi.fn(),
    },
}))
const notify = vi.fn()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { workspaceService } from '@/services/workspaceService'

const VERSIONED: WorkspaceDataSourceImpactResponse = {
    views: [{ id: 'v1', name: 'Finance lineage', type: 'view' }],
    restoreWindowDays: 30,
    versioning: {
        versioned: true,
        commits: 71,
        openDrafts: [
            { id: 'br1', name: 'Untitled draft', owner: 'Priya Raman' },
            { id: 'br2', name: 'Q3 rework', owner: 'Sam Okoro' },
        ],
        openReviews: 2,
        curatedEntities: 181,
        storageBytes: 11_057_400,
        falkorGraphName: 'nexus_lineage',
        falkorGraphOwned: false,
    },
}

describe('the versioned blast radius', () => {
    it('names the irreplaceable things, and puts the drafts first', () => {
        const s = impactSections(VERSIONED, true)
        // Drafts lead: the only line belonging to someone who is not in the room.
        expect(s[0].label).toBe('Unpublished drafts')
        expect(s[0].count).toBe(2)
        expect(s.find(x => x.label === 'Hand-curated entities')?.count).toBe(181)
        expect(s.find(x => x.label === 'Open reviews')?.count).toBe(2)
        expect(s.find(x => x.label === 'Revisions')?.count).toBe(71)
        expect(s.find(x => x.label.startsWith('View'))?.count).toBe(1)
    })

    it('identifies a draft by its OWNER — "Untitled draft" identifies nobody', () => {
        expect(impactSections(VERSIONED, true)[0].items?.map(i => i.name)).toEqual([
            'Untitled draft — Priya Raman',
            'Q3 rework — Sam Okoro',
        ])
    })

    it('a REVERSIBLE removal does not claim things are erased', () => {
        const soft = impactSections(VERSIONED, false)
        const hard = impactSections(VERSIONED, true)
        // Same counts — the disruption is identical and the user still sees all of it...
        expect(soft.map(s => s.count)).toEqual(hard.map(s => s.count))
        // ...but nothing is described as destroyed, because nothing is.
        expect(soft.find(s => s.label === 'Revisions')?.consequence).not.toContain('erased')
        expect(hard.find(s => s.label === 'Revisions')?.consequence).toContain('erased')
    })

    it('an unversioned source shows only the views', () => {
        const s = impactSections(
            { views: [{ id: 'v1', name: 'A', type: 'view' }], versioning: null, restoreWindowDays: 30 })
        expect(s).toHaveLength(1)
        expect(s[0].label).toBe('View')          // one view; the label agrees with the count
    })
})

describe('the caveat', () => {
    it('leads with the undo window when the delete is reversible', () => {
        const c = deleteCaveat(VERSIONED, false)
        expect(c).toContain('Offboarded, not deleted')
        expect(c).toContain('30 days')
    })

    it('says their graph data is safe when the graph is not ours', () => {
        const c = deleteCaveat(VERSIONED, true)
        expect(c).toContain('nexus_lineage')
        expect(c).toContain('safe')
        expect(c).toContain('cannot be undone')
    })

    it('does NOT reassure when the graph IS ours — we are about to drop it', () => {
        const owned: WorkspaceDataSourceImpactResponse = {
            ...VERSIONED,
            versioning: { ...VERSIONED.versioning!, falkorGraphOwned: true,
                          falkorGraphName: 'gv_abc123' },
        }
        const c = deleteCaveat(owned, true)
        expect(c).toContain('also deletes the managed graph')
        expect(c).not.toContain('safe')
    })
})

describe('a failed impact probe', () => {
    beforeEach(() => vi.clearAllMocks())

    it('reports UNKNOWN, never an empty impact', async () => {
        // The old flow caught the error, left the impact null, and the dialog's
        // total-count-is-zero branch told the user "Nothing else will be affected" —
        // the most dangerous sentence available at the moment we knew least.
        vi.mocked(workspaceService.getDataSourceImpact).mockRejectedValue(new Error('502'))

        const { result } = renderHook(() => useDataSourceDeletion('ws1', () => {}))
        await act(async () => { await result.current.open('ds1', 'Finance') })

        await waitFor(() => expect(result.current.target?.loading).toBe(false))
        expect(result.current.target?.unknown).toBe(true)
        expect(result.current.target?.impact).toBeNull()
    })

    it('a SUCCESSFUL empty probe is genuinely safe, and says so', async () => {
        vi.mocked(workspaceService.getDataSourceImpact)
            .mockResolvedValue({ views: [], versioning: null, restoreWindowDays: 30 })

        const { result } = renderHook(() => useDataSourceDeletion('ws1', () => {}))
        await act(async () => { await result.current.open('ds1', 'Scratch') })

        await waitFor(() => expect(result.current.target?.loading).toBe(false))
        expect(result.current.target?.unknown).toBe(false)   // <- the distinction that matters
        const total = impactSections(result.current.target?.impact ?? null)
            .reduce((n, s) => n + s.count, 0)
        expect(total).toBe(0)
    })
})

describe('offboard vs delete permanently', () => {
    beforeEach(() => vi.clearAllMocks())

    it('offboard is reversible, and hands the user an Undo', async () => {
        vi.mocked(workspaceService.getDataSourceImpact).mockResolvedValue(VERSIONED)
        const onChanged = vi.fn()
        const { result } = renderHook(() => useDataSourceDeletion('ws1', onChanged))

        await act(async () => { await result.current.open('ds1', 'Finance') })
        await waitFor(() => expect(result.current.target?.permanent).toBe(false))
        await act(async () => { await result.current.confirm() })

        expect(workspaceService.removeDataSource).toHaveBeenCalledWith('ws1', 'ds1', false)
        expect(onChanged).toHaveBeenCalled()

        // The undo is IN the notification. Most undos happen seconds after the mistake, long before
        // anyone thinks to go hunting for a trash can — so the trash comes to them.
        const [, msg, action] = notify.mock.calls.at(-1)!
        expect(msg).toBe('Finance offboarded')
        expect(action.label).toBe('Undo')

        await act(async () => { action.onClick() })
        await waitFor(() =>
            expect(workspaceService.restoreDataSource).toHaveBeenCalledWith('ws1', 'ds1'))
    })

    it('delete permanently is irreversible, and offers no Undo', async () => {
        vi.mocked(workspaceService.getDataSourceImpact).mockResolvedValue(VERSIONED)
        const { result } = renderHook(() => useDataSourceDeletion('ws1', () => {}))

        await act(async () => { await result.current.openPermanent('ds1', 'Finance') })
        await waitFor(() => expect(result.current.target?.permanent).toBe(true))
        await act(async () => { await result.current.confirm() })

        expect(workspaceService.removeDataSource).toHaveBeenCalledWith('ws1', 'ds1', true)
        const [, msg, action] = notify.mock.calls.at(-1)!
        expect(msg).toBe('Finance deleted permanently')
        expect(action).toBeUndefined()          // there is nothing to undo, so do not pretend
    })
})
