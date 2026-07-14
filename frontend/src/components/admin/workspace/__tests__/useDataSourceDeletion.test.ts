/**
 * The delete dialog's job is to tell the truth about what is about to be destroyed.
 *
 * These tests pin the three ways it previously lied:
 *   1. it never mentioned the version history at all;
 *   2. a FAILED impact probe rendered as the green "safe to delete" panel;
 *   3. it reassured people about graph data we were in fact about to drop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
    impactSections, deleteCaveat, useDataSourceDeletion,
} from '../useDataSourceDeletion'
import type { WorkspaceDataSourceImpactResponse } from '@/services/workspaceService'

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { getDataSourceImpact: vi.fn(), removeDataSource: vi.fn() },
}))
import { workspaceService } from '@/services/workspaceService'

const VERSIONED: WorkspaceDataSourceImpactResponse = {
    views: [{ id: 'v1', name: 'Finance lineage', type: 'view' }],
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
        const s = impactSections(VERSIONED)
        // Drafts lead: they are the only line belonging to someone not in the room.
        expect(s[0].label).toBe('Unpublished drafts')
        expect(s[0].count).toBe(2)
        expect(s.find(x => x.label === 'Hand-curated entities')?.count).toBe(181)
        expect(s.find(x => x.label === 'Open reviews')?.count).toBe(2)
        expect(s.find(x => x.label === 'Revisions')?.count).toBe(71)
        expect(s.find(x => x.label.startsWith('View'))?.count).toBe(1)
    })

    it('identifies a draft by its OWNER — "Untitled draft" identifies nobody', () => {
        const drafts = impactSections(VERSIONED)[0]
        expect(drafts.items?.map(i => i.name)).toEqual([
            'Untitled draft — Priya Raman',
            'Q3 rework — Sam Okoro',
        ])
    })

    it('says their graph data is safe when the graph is not ours', () => {
        const caveat = deleteCaveat(VERSIONED)
        expect(caveat).toContain('nexus_lineage')
        expect(caveat).toContain('safe')
    })

    it('does NOT reassure when the graph IS ours — we are about to drop it', () => {
        const owned: WorkspaceDataSourceImpactResponse = {
            ...VERSIONED,
            versioning: { ...VERSIONED.versioning!, falkorGraphOwned: true,
                          falkorGraphName: 'gv_abc123' },
        }
        const caveat = deleteCaveat(owned)
        expect(caveat).toContain('also deletes the graph')
        expect(caveat).not.toContain('safe')
    })

    it('an unversioned source shows only the views', () => {
        const s = impactSections({ views: [{ id: 'v1', name: 'A', type: 'view' }], versioning: null })
        expect(s).toHaveLength(1)
        expect(s[0].label).toBe('View')          // one view; the label agrees with the count
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
        // and therefore: sections are empty, but `unknown` — not the empty sections —
        // is what the dialog keys the green panel off.
        expect(impactSections(result.current.target?.impact ?? null)).toEqual([])
    })

    it('a SUCCESSFUL empty probe is genuinely safe, and says so', async () => {
        vi.mocked(workspaceService.getDataSourceImpact)
            .mockResolvedValue({ views: [], versioning: null })

        const { result } = renderHook(() => useDataSourceDeletion('ws1', () => {}))
        await act(async () => { await result.current.open('ds1', 'Scratch') })

        await waitFor(() => expect(result.current.target?.loading).toBe(false))
        expect(result.current.target?.unknown).toBe(false)   // <- the distinction that matters
        // A section may exist with count 0; the dialog keys the green panel off the SUM, so
        // what must be true is that nothing is destroyed — not that the array is empty.
        const total = impactSections(result.current.target?.impact ?? null)
            .reduce((n, s) => n + s.count, 0)
        expect(total).toBe(0)
    })
})
