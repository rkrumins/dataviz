/**
 * The drawers' footer facts: Updated (who, when — the draft's own change marked) and Synced, the
 * same in both drawers; a change on the published graph since the draft began called out; the
 * live graph's catch-up shown while it happens.
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

beforeEach(() => {
  h.watermark = { committed: 5, projected: 5, fresh: true, status: 'idle', lastProjectedAt: '2026-02-01T00:05:00Z' }
})

describe('DrawerActivity', () => {
  it('says who last changed it — marking the draft’s own change — and when the live graph caught up', () => {
    render(<DrawerActivity summary={summary()} loading={false} wsId="ws" graphId="g" inDraft />)
    expect(screen.getByText('Updated · draft').closest('div')).toHaveTextContent('Bo')
    expect(screen.getByText('Synced')).toBeInTheDocument()
    expect(screen.queryByText(/Created/)).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('calls out a change on the published graph since the draft began', () => {
    render(<DrawerActivity summary={summary({ changedOnMainSinceBranch: true })} loading={false} wsId="ws" graphId="g" inDraft />)
    expect(screen.getByRole('status')).toHaveTextContent(/Changed on the published graph since this draft began/)
  })

  it('shows the live graph catching up', () => {
    h.watermark = { committed: 6, projected: 5, fresh: false, status: 'projecting', lastProjectedAt: '2026-02-01T00:05:00Z' }
    render(<DrawerActivity summary={summary()} loading={false} wsId="ws" graphId="g" inDraft={false} />)
    expect(screen.getByText('Syncing').closest('div')).toHaveTextContent('In progress…')
  })

  it('says so when nothing has changed', () => {
    render(<DrawerActivity summary={summary({ updated: null })} loading={false} wsId="ws" graphId="g" inDraft={false} />)
    expect(screen.getByText('Updated').closest('div')).toHaveTextContent('No changes yet')
  })
})
