/**
 * What a view's design holds, by its headline count: a view made from a query its members
 * (`stats.members`), any other view its placements — and a server from before members were
 * counted still reads by its placements. Pinned on the helpers, and on a draft's review, where a
 * new view waiting in the draft says what it holds.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { DraftViewChanges } from '@/features/versioning/components/DraftViewChanges'
import type { BundleManifest } from '@/services/viewTransferApiService'
import { fileHeldCount, heldCount, heldText } from '../format'

const MANIFEST: BundleManifest = { counts: { layers: 2, assignments: 0 }, entities: {}, entitiesResolved: true }

describe('heldCount', () => {
  it('reads a view made from a query by its members', () => {
    expect(heldText(heldCount({ assignments: 0, members: 3400 }))).toBe('3,400 members')
    expect(heldText(heldCount({ assignments: 0, members: 1 }))).toBe('1 member')
  })

  it('reads any other view, and an older answer, by its placements', () => {
    expect(heldText(heldCount({ assignments: 120 }))).toBe('120 placements')
    expect(heldText(heldCount(undefined))).toBe('0 placements')
  })

  it('counts a snapshot in a file by the members it carries', () => {
    const members = { format: 'rows-v1' as const, count: 52, columns: ['urn'], rows: [] }
    expect(fileHeldCount({ manifest: MANIFEST, members })).toEqual({ count: 52, unit: 'member' })
    expect(fileHeldCount({ manifest: MANIFEST })).toEqual({ count: 0, unit: 'placement' })
  })
})

describe('DraftViewChanges — a new view waiting in a draft', () => {
  it('says how many members a view made from a query holds', () => {
    render(
      <MemoryRouter>
        <DraftViewChanges branchId="br_1" changes={{
          branchId: 'br_1', hidden: 0,
          views: [
            { viewId: 'v_list', workspaceId: 'ws1', name: 'Payments made from a query', change: 'create', origin: null,
              matchRate: null, stats: { layers: 3, assignments: 0, members: 50_820 }, goesLiveAs: 'private' },
            { viewId: 'v_plain', workspaceId: 'ws1', name: 'Finance lineage', change: 'create', origin: null,
              matchRate: null, stats: { layers: 3, assignments: 1240 }, goesLiveAs: 'private' },
          ],
        }} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/3 layers, 50,820 members · goes live private/)).toBeInTheDocument()
    expect(screen.getByText(/3 layers, 1,240 placements · goes live private/)).toBeInTheDocument()
  })
})
