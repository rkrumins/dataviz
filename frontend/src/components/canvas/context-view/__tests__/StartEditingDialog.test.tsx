/**
 * StartEditingDialog — "Continue a draft" lists only drafts the user can write: their own, and shared
 * drafts they edit or maintain. Someone else's private draft (a manager reads every one) would take
 * an hour of edits and then refuse the save.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

let branchesData: unknown[] = []

vi.mock('@/store/auth', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'ana' } }),
}))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ switchToDraft: vi.fn() }),
}))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
  useBranches: () => ({ data: branchesData }),
  useOpenDraft: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
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
})
