/**
 * CommitRow rollback menu — pins the gating: the "Revision actions" menu
 * renders only when rollback handlers are provided, and genesis rows never
 * offer "Undo just this change" (only restore, which validly empties the graph).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../hooks/useVersioning', () => ({
  useCommitDiffSummary: () => ({ data: undefined, isLoading: false }),
  useSquashedCommits: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/services/versioningApiService', () => ({ getCommitDiffChildren: vi.fn() }))
vi.mock('../ChangeTreePanel', () => ({ ChangeTreePanel: () => null }))

import { CommitRow } from '../CommitRow'

const COMMIT = {
  commit_id: 'cmt_1',
  kind: 'squash_publish',
  message: 'published wave',
  actor: 'alice',
  created_at: '2026-07-12T10:00:00Z',
  stats: {},
}

const base = {
  wsId: 'ws1',
  graphId: 'g1',
  expanded: false,
  onToggle: () => {},
}

describe('CommitRow rollback menu', () => {
  it('renders no actions menu without handlers (read-only contexts)', () => {
    render(<ol><CommitRow {...base} commit={COMMIT} /></ol>)
    expect(screen.queryByLabelText('Revision actions')).not.toBeInTheDocument()
  })

  it('renders the actions menu when rollback handlers are provided', () => {
    render(<ol><CommitRow {...base} commit={COMMIT} onRevert={() => {}} onRestore={() => {}} /></ol>)
    expect(screen.getByLabelText('Revision actions')).toBeInTheDocument()
  })

  it('genesis rows still get the menu for restore, even though revert is invalid', () => {
    render(
      <ol>
        <CommitRow {...base} commit={{ ...COMMIT, kind: 'genesis' }} onRevert={() => {}} onRestore={() => {}} />
      </ol>,
    )
    expect(screen.getByLabelText('Revision actions')).toBeInTheDocument()
  })

  it('genesis rows get NO menu when only revert is offered', () => {
    render(
      <ol>
        <CommitRow {...base} commit={{ ...COMMIT, kind: 'genesis' }} onRevert={() => {}} />
      </ol>,
    )
    expect(screen.queryByLabelText('Revision actions')).not.toBeInTheDocument()
  })
})
