/**
 * useBranchDeepLink — pins the permission-gated deep-link behaviour:
 *   • ?branch=<id> that names an accessible open draft → switches to it;
 *   • ?branch=<id> the viewer can't access (absent from the gated branch list) → no switch + notification;
 *   • no param → no-op.
 */
import React from 'react'
import { renderHook } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

const notify = vi.fn()
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { useBranchDeepLink } from '../useBranchDeepLink'

const wrap = (initial: string) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  }

// A wrapper that also mirrors the live URL search string into `probe.search`, so a test can
// assert whether the store→URL effect stamped (or cleared) the ?branch= param.
const probe = { search: '' }
const wrapWithProbe = (initial: string) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    function LocationProbe() {
      probe.search = useLocation().search
      return null
    }
    return (
      <MemoryRouter initialEntries={[initial]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    )
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

  it('rejects ?branch the viewer cannot access and notifies', () => {
    notify.mockClear()
    const switchToDraft = vi.fn()
    renderHook(
      () => useBranchDeepLink({ enabled: true, branches: [], currentBranchId: null, switchToDraft }),
      { wrapper: wrap('/views/v1?branch=br_secret') },
    )
    expect(switchToDraft).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('error', expect.stringContaining("isn't available"))
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

  it('defers adoption until the store has resolved the ACTIVE view (branch-per-view scope gate)', () => {
    notify.mockClear()
    const switchToDraft = vi.fn()
    const { rerender } = renderHook(
      ({ scopeViewId }: { scopeViewId: string | null }) =>
        useBranchDeepLink({
          enabled: true, branches: [draft('br_1')], currentBranchId: null,
          scopeViewId, activeViewId: 'v1', switchToDraft,
        }),
      { wrapper: wrap('/views/v1?branch=br_1'), initialProps: { scopeViewId: 'v0' } },
    )
    // Store still resolved for the PREVIOUS view (mid view-switch) → must not adopt or notify.
    expect(switchToDraft).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    // Once the store has resolved the active view, the link is honoured.
    rerender({ scopeViewId: 'v1' })
    expect(switchToDraft).toHaveBeenCalledWith('br_1', null)
  })

  it('does NOT stamp the branch into the URL while the store scope lags the active view', () => {
    probe.search = ''
    renderHook(
      () =>
        useBranchDeepLink({
          enabled: true, branches: [draft('br_1')], currentBranchId: 'br_1',
          scopeViewId: 'v0', activeViewId: 'v1', switchToDraft: vi.fn(),
        }),
      { wrapper: wrapWithProbe('/views/v1') },
    )
    // currentBranchId is set but it belongs to the PREVIOUS view (scope v0 ≠ active v1), so the
    // ?branch= param must NOT be written onto this view's URL — that was the "branch leaks across
    // views" bug. It only syncs once scope catches up to the active view.
    expect(probe.search).toBe('')
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
    // notifying) on that list branded the user's own draft "not available".
    notify.mockClear()
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
    // Stale list mid-refresh → neither reject nor notify.
    expect(switchToDraft).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    // Fresh list lands with the draft → applied.
    rerender({ branches: [draft('br_new')], listRefreshing: false })
    expect(switchToDraft).toHaveBeenCalledWith('br_new', null)
    expect(notify).not.toHaveBeenCalled()
  })
})
