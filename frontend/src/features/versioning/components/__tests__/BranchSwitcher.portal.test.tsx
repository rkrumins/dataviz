/**
 * BranchSwitcher — the menu must PORTAL out of its host header.
 *
 * The Context View header carries `backdrop-blur-xl`, and a backdrop-filter creates a
 * stacking context: as an absolutely-positioned descendant the menu's `z-50` only competed
 * INSIDE the header, so the canvas columns below (relative z-30, later in the DOM) painted
 * over it — the menu opened and could not be seen. These tests fail on that old shape.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const switchToMain = vi.fn()
const switchToDraft = vi.fn()
const branchState = {
  currentBranchId: null as string | null,
  viewId: 'v1',
  setResolved: vi.fn(),
  switchToMain,
  switchToDraft,
}

let branchesData: unknown[] = []

vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('@/store/schema', () => ({ useActiveView: () => ({ id: 'v1' }) }))
vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel(branchState),
}))
vi.mock('../../hooks/useBranchDeepLink', () => ({ useBranchDeepLink: () => {} }))
vi.mock('../../hooks/useVersioning', () => ({
  useResolveGraph: () => ({ data: { graphId: 'g1', mainHeadCommitSeq: 5 }, isLoading: false, isError: false }),
  useBranches: () => ({ data: branchesData, isLoading: false, isFetching: false }),
  useMergeRequests: () => ({ data: [{ sourceBranchId: 'br_1', status: 'open' }] }),
  useOpenDraft: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('../PullLatestButton', () => ({ PullLatestButton: () => null }))
vi.mock('../BranchSettingsModal', () => ({ BranchSettingsModal: () => null }))
vi.mock('../BranchManager', () => ({ BranchManager: () => null }))

import { BranchSwitcher } from '../BranchSwitcher'

const draft = (over: Record<string, unknown> = {}) => ({
  branchId: 'br_1', kind: 'draft', status: 'open', name: 'Q3 pricing',
  owner: 'ana@acme.com', baseCommitSeq: 5, originatingViewId: 'v1',
  createdAt: '2026-06-10T00:00:00Z', updatedAt: '2026-06-14T00:00:00Z',
  ...over,
})

/** The real host: a blurred header band. `backdrop-filter` is what strands an inline menu. */
const renderInBlurredHeader = () =>
  render(
    <div data-testid="header" className="backdrop-blur-xl">
      <BranchSwitcher workspaceId="ws1" dataSourceId="ds1" />
    </div>,
  )

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: /Published/ }))
  return screen.getByRole('dialog', { name: 'Version' })
}

describe('BranchSwitcher menu', () => {
  beforeEach(() => {
    branchesData = []
    switchToMain.mockClear()
    switchToDraft.mockClear()
    branchState.currentBranchId = null
  })

  it('renders the menu OUTSIDE the blurred header (portals to the body)', () => {
    renderInBlurredHeader()
    const menu = openMenu()
    expect(screen.getByTestId('header').contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    expect(menu.closest('[data-testid="header"]')).toBeNull()
    // Fixed to the viewport and above the canvas columns, not `absolute … z-50`.
    expect(menu.style.position).toBe('fixed')
    expect(Number(menu.style.zIndex)).toBeGreaterThan(30)
  })

  it('is openable and its rows are reachable', () => {
    branchesData = [draft()]
    renderInBlurredHeader()
    const menu = openMenu()
    // Published row, the drafts list, the per-draft PR badge and create-draft all survive the move.
    expect(screen.getByText('Q3 pricing')).toBeInTheDocument()
    expect(menu.querySelector('[title="A review (PR) is already open for this draft"]')).not.toBeNull()
    expect(screen.getByText(/New draft|Create/i)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Q3 pricing'))
    expect(switchToDraft).toHaveBeenCalledWith('br_1', 'v1')
  })

  it('advertises itself to assistive tech', () => {
    renderInBlurredHeader()
    const trigger = screen.getByRole('button', { name: /Published/ })
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
  })

  it('stays open while clicking its own rows, and closes on an outside click', () => {
    branchesData = [draft()]
    renderInBlurredHeader()
    const menu = openMenu()
    // The menu is no longer a descendant of the trigger's wrapper: a containment test
    // against that wrapper alone would close it here.
    fireEvent.mouseDown(menu)
    expect(screen.queryByRole('dialog', { name: 'Version' })).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: 'Version' })).not.toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the trigger', () => {
    renderInBlurredHeader()
    openMenu()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Version' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Published/ }))
  })
})
