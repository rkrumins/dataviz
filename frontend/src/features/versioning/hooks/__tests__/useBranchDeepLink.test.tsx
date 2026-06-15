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
      { wrapper: wrap('/views/v1?branch=br_1'), initialProps: { branches: undefined } },
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
})
