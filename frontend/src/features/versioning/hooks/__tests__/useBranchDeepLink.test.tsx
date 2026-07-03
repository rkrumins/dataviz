/**
 * useBranchDeepLink — pins the permission-gated deep-link behaviour:
 *   • ?branch=<id> that names an accessible open draft → switches to it;
 *   • ?branch=<id> the viewer can't access (absent from the gated branch list) → no switch + toast;
 *   • no param → no-op.
 */
import React from 'react'
import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

const showToast = vi.fn()
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ showToast }) }))

import { useBranchDeepLink } from '../useBranchDeepLink'

const wrap = (initial: string) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  }

const draft = (branchId: string) =>
  ({ branchId, kind: 'draft', status: 'open', createdAt: '', updatedAt: '' } as never)

describe('useBranchDeepLink', () => {
  it('applies ?branch when it is an accessible open draft', () => {
    const switchToDraft = vi.fn()
    renderHook(
      () => useBranchDeepLink({ enabled: true, branches: [draft('br_1')], currentBranchId: null, switchToDraft }),
      { wrapper: wrap('/views/v1?branch=br_1') },
    )
    expect(switchToDraft).toHaveBeenCalledWith('br_1', null)
  })

  it('rejects ?branch the viewer cannot access and toasts', () => {
    showToast.mockClear()
    const switchToDraft = vi.fn()
    renderHook(
      () => useBranchDeepLink({ enabled: true, branches: [], currentBranchId: null, switchToDraft }),
      { wrapper: wrap('/views/v1?branch=br_secret') },
    )
    expect(switchToDraft).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining("isn't available"))
  })

  it('preserves the deep-link param while branches are still loading (no lost-deeplink race)', () => {
    const switchToDraft = vi.fn()
    const { rerender } = renderHook(
      ({ branches }: { branches: ReturnType<typeof draft>[] | undefined }) =>
        useBranchDeepLink({ enabled: true, branches, currentBranchId: null, switchToDraft }),
      {
        wrapper: wrap('/views/v1?branch=br_1'),
        initialProps: { branches: undefined as ReturnType<typeof draft>[] | undefined },
      },
    )
    // Branches not loaded yet → must not act, and crucially must NOT strip ?branch=.
    expect(switchToDraft).not.toHaveBeenCalled()
    // Branches arrive → the still-present param is honoured (proves it survived the loading phase).
    rerender({ branches: [draft('br_1')] })
    expect(switchToDraft).toHaveBeenCalledWith('br_1', null)
  })

  it('does nothing when there is no ?branch param', () => {
    const switchToDraft = vi.fn()
    renderHook(
      () => useBranchDeepLink({ enabled: true, branches: [], currentBranchId: null, switchToDraft }),
      { wrapper: wrap('/views/v1') },
    )
    expect(switchToDraft).not.toHaveBeenCalled()
  })

  it('defers rejection while the branch list is refreshing, then applies the fresh list', () => {
    // Regression: a just-opened draft is in the URL but not yet in the STALE
    // cached list react-query serves during a refetch — rejecting (and
    // toasting) on that list branded the user's own draft "not available".
    showToast.mockClear()
    const switchToDraft = vi.fn()
    const { rerender } = renderHook(
      ({ branches, listRefreshing }: {
        branches: ReturnType<typeof draft>[]; listRefreshing: boolean
      }) =>
        useBranchDeepLink({ enabled: true, branches, listRefreshing, currentBranchId: null, switchToDraft }),
      {
        wrapper: wrap('/views/v1?branch=br_new'),
        initialProps: { branches: [] as ReturnType<typeof draft>[], listRefreshing: true },
      },
    )
    // Stale list mid-refresh → neither reject nor toast.
    expect(switchToDraft).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
    // Fresh list lands with the draft → applied.
    rerender({ branches: [draft('br_new')], listRefreshing: false })
    expect(switchToDraft).toHaveBeenCalledWith('br_new', null)
    expect(showToast).not.toHaveBeenCalled()
  })
})
