/**
 * StartEditingDialog — "Continue a draft" lists only drafts the user can write: their own, and shared
 * drafts they edit or maintain. Someone else's private draft (a manager reads every one) would take
 * an hour of edits and then refuse the save.
 *
 * A new branch refused because editing is paused says so in the server's words, not "try again".
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { GraphNotWritableError } from '@/services/versioningApiService'

let branchesData: unknown[] = []
let openDraftError: Error | null = null

vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'ana' } }),
}))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToDraft: vi.fn() }),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useBranches: () => ({ data: branchesData }),
  useOpenDraft: () => ({ mutate: vi.fn(), isPending: false, isError: openDraftError != null, error: openDraftError }),
  VERSIONING_KEYS: { all: ['versioning'] },
}))

import { StartEditingDialog } from '../StartEditingDialog'

const draft = (over: Record<string, unknown>) => ({
  kind: 'draft', status: 'open', owner: 'ana', updatedAt: '2026-06-14T00:00:00Z', ...over,
})

describe('StartEditingDialog', () => {
  it('offers to continue only the drafts the user can write', () => {
    branchesData = [
      draft({ branchId: 'br_own', name: 'Mine' }),
      draft({ branchId: 'br_bob', name: 'Bob private', owner: 'bob' }),
      draft({ branchId: 'br_ed', name: 'Shared, editor', owner: 'bob', isShared: true, myRole: 'editor' }),
      draft({ branchId: 'br_view', name: 'Shared, viewer', owner: 'bob', isShared: true, myRole: 'viewer' }),
    ]
    render(<StartEditingDialog wsId="ws1" graphId="g1" viewId="v1" onClose={vi.fn()} />)
    expect(screen.getByText('Mine')).toBeInTheDocument()
    expect(screen.getByText('Shared, editor')).toBeInTheDocument()
    expect(screen.queryByText('Bob private')).not.toBeInTheDocument()
    expect(screen.queryByText('Shared, viewer')).not.toBeInTheDocument()
  })

  it("says editing is paused, in the server's words, when a new branch is refused for it", () => {
    branchesData = []
    const message = "Editing is paused on this graph. A publisher can resume it from the data source's Version control tab."
    openDraftError = new GraphNotWritableError(message)
    render(<StartEditingDialog wsId="ws1" graphId="g1" viewId="v1" onClose={vi.fn()} />)
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.queryByText(/try again/)).not.toBeInTheDocument()
  })

  it('asks to try again when a new branch fails for any other reason', () => {
    branchesData = []
    openDraftError = new Error('500')
    render(<StartEditingDialog wsId="ws1" graphId="g1" viewId="v1" onClose={vi.fn()} />)
    expect(screen.getByText('Couldn’t create the branch — try again.')).toBeInTheDocument()
  })
})
