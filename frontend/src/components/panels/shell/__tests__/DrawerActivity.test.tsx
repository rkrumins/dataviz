/**
 * The drawers' footer facts: Created · Updated · Synced, each saying who or what — the draft's own
 * changes tagged, a change on the published graph since the draft began called out, and the live
 * graph's catch-up shown while it happens.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntitySummary, Watermark } from '@/services/versioningApiService'

const h = vi.hoisted(() => ({ watermark: undefined as Watermark | undefined }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useProjectionWatermark: () => ({ data: h.watermark }),
}))

import { DrawerActivity } from '../DrawerActivity'

const summary = (over: Partial<EntitySummary> = {}): EntitySummary => ({
  entityId: 'e1', kind: 'node', exists: true, version: 'v2', inherited: false,
  created: { at: '2026-01-01T00:00:00Z', actor: 'usr_ana', op: 'create', commitId: 'c1', inDraft: false },
  updated: { at: '2026-02-01T00:00:00Z', actor: 'usr_bo', op: 'update', commitId: 'c2', inDraft: true },
  revisions: { published: 2, draft: 1 }, changedOnMainSinceBranch: false, baseCommitSeq: 4,
  userNames: { usr_ana: 'Ana', usr_bo: 'Bo' },
  ...over,
} as EntitySummary)

const card = (label: string) => screen.getByText(label).closest('div') as HTMLElement

beforeEach(() => {
  h.watermark = { committed: 5, projected: 5, fresh: true, status: 'idle', lastProjectedAt: '2026-02-01T00:05:00Z' }
})

describe('DrawerActivity', () => {
  it('says who created and last changed it, tags the draft’s own change, and when the live graph caught up', () => {
    render(<DrawerActivity summary={summary()} loading={false} wsId="ws" graphId="g" inDraft />)
    expect(card('Created')).toHaveTextContent('Ana')
    expect(card('Created')).not.toHaveTextContent('draft')
    expect(card('Updated')).toHaveTextContent('Bo')
    expect(card('Updated')).toHaveTextContent('draft')
    expect(card('Synced')).toHaveTextContent('Live graph')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('calls out a change on the published graph since the draft began', () => {
    render(<DrawerActivity summary={summary({ changedOnMainSinceBranch: true })} loading={false} wsId="ws" graphId="g" inDraft />)
    expect(screen.getByRole('status')).toHaveTextContent(/Changed on the published graph since this draft began/)
  })

  it('shows the live graph catching up', () => {
    h.watermark = { committed: 6, projected: 5, fresh: false, status: 'projecting', lastProjectedAt: '2026-02-01T00:05:00Z' }
    render(<DrawerActivity summary={summary()} loading={false} wsId="ws" graphId="g" inDraft={false} />)
    expect(card('Syncing')).toHaveTextContent('Catching up…')
  })

  it('says so when nothing is recorded', () => {
    render(<DrawerActivity summary={summary({ created: null, updated: null })} loading={false} wsId="ws" graphId="g" inDraft={false} />)
    expect(card('Created')).toHaveTextContent('Not recorded')
    expect(card('Updated')).toHaveTextContent('No changes yet')
  })
})
