/**
 * BranchSwitcher — drafts by whose they are, with their level:
 *   • the reader's own drafts, then those shared with them, then the public ones, each marked
 *     public or private;
 *   • a new draft starts at its data source's policy default, unless another level is chosen; a
 *     level the policy rules out can't be.
 */
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const openMutate = vi.fn()
let branchesData: unknown[] = []
let policy: { effective: { defaultVisibility: string; levels: string } } | undefined

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/auth', () => ({
  usePermission: () => true,
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'ana' } }),
}))
vi.mock('@/store/schema', () => ({ useActiveView: () => ({ id: 'v1' }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({
    currentBranchId: null, viewId: 'v1', setResolved: vi.fn(), switchToMain: vi.fn(), switchToDraft: vi.fn(),
  }),
}))
vi.mock('../../hooks/useBranchDeepLink', () => ({ useBranchDeepLink: () => {} }))
vi.mock('../../hooks/useVersioning', () => ({
  useResolveGraph: () => ({ data: { graphId: 'g1', mainHeadCommitSeq: 5 }, isLoading: false, isError: false }),
  useBranches: () => ({ data: branchesData, isLoading: false, isFetching: false }),
  useMergeRequests: () => ({ data: [] }),
  useOpenDraft: () => ({ mutate: openMutate, isPending: false }),
  useDataSourceDraftsPolicy: () => ({ data: policy }),
}))
vi.mock('../PullLatestButton', () => ({ PullLatestButton: () => null }))
vi.mock('../BranchSettingsModal', () => ({ BranchSettingsModal: () => null }))
vi.mock('../BranchManager', () => ({ BranchManager: () => null }))

import { BranchSwitcher } from '../BranchSwitcher'

const draft = (over: Record<string, unknown>) => ({
  kind: 'draft', status: 'open', owner: 'ana', baseCommitSeq: 5, originatingViewId: 'v1',
  createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-14T00:00:00Z', ...over,
})

const openMenu = () => {
  render(<BranchSwitcher workspaceId="ws1" dataSourceId="ds1" />)
  fireEvent.click(screen.getByRole('button', { name: /Published/ }))
  return screen.getByRole('dialog', { name: 'Version' })
}

describe('BranchSwitcher drafts by whose they are', () => {
  beforeEach(() => {
    openMutate.mockReset()
    policy = { effective: { defaultVisibility: 'public', levels: 'any' } }
    branchesData = [
      draft({ branchId: 'br_pub', name: 'Bob public', owner: 'bob', visibility: 'public' }),
      draft({ branchId: 'br_mine', name: 'Mine', visibility: 'private' }),
      draft({ branchId: 'br_team', name: 'Team', owner: 'bob', visibility: 'private', myRole: 'editor' }),
    ]
  })

  it('lists the reader’s own, then those shared with them, then the public ones, marked by level', () => {
    const menu = openMenu()
    const text = menu.textContent ?? ''
    expect(text.indexOf('Your drafts')).toBeLessThan(text.indexOf('Mine'))
    expect(text.indexOf('Mine')).toBeLessThan(text.indexOf('Shared with you'))
    expect(text.indexOf('Shared with you')).toBeLessThan(text.indexOf('Team'))
    expect(text.indexOf('Team')).toBeLessThan(text.indexOf('Public drafts'))
    expect(text.indexOf('Public drafts')).toBeLessThan(text.indexOf('Bob public'))
    expect(within(menu).getAllByRole('img', { name: 'Private draft' })).toHaveLength(2)
    expect(within(menu).getAllByRole('img', { name: 'Public draft' })).toHaveLength(1)
  })

  it('starts a new draft at the policy’s default, or at the level chosen', () => {
    policy = { effective: { defaultVisibility: 'private', levels: 'any' } }
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /New draft/ }))
    expect(screen.getByRole('radio', { name: /Private/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(openMutate.mock.calls[0][0].visibility).toBeUndefined()     // the policy decides
    fireEvent.click(screen.getByRole('radio', { name: /Public/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(openMutate.mock.calls[1][0].visibility).toBe('public')
  })

  it('offers no level the policy rules out', () => {
    policy = { effective: { defaultVisibility: 'public', levels: 'public_only' } }
    openMenu()
    fireEvent.click(screen.getByRole('button', { name: /New draft/ }))
    expect(screen.getByRole('radio', { name: /Private/ })).toBeDisabled()
  })
})
