/**
 * ViewVersioningPanel — pins the manage-gating of the "Data health" tab: it is present in the tab
 * bar only when `canManage` is true. The panel's tab bodies and data hooks are stubbed so the test
 * stays focused on which tabs render.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../hooks/useVersioning', () => ({
  useBranchDiffSummary: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/services/versioningApiService', () => ({ getBranchDiffChildren: vi.fn() }))
vi.mock('@/store/stagedChangesStore', () => ({
  useStagedChangesStore: (sel: (s: unknown) => unknown) => sel({ changes: [], openReviewPanel: vi.fn() }),
}))
vi.mock('../ChangeTreePanel', () => ({ ChangeTreePanel: () => null }))
vi.mock('../../../reviews/components/ViewPrList', () => ({ ViewPrList: () => null }))
vi.mock('../ViewHistoryTimeline', () => ({ ViewHistoryTimeline: () => null }))
vi.mock('../DataHealthTab', () => ({ DataHealthTab: () => <div>data-health-body</div> }))

import { ViewVersioningPanel } from '../ViewVersioningPanel'

const renderPanel = (canManage: boolean) =>
  render(
    <ViewVersioningPanel wsId="ws1" graphId="g1" branchId={null} canManage={canManage} onClose={() => {}} />,
  )

describe('ViewVersioningPanel — Data health tab gating', () => {
  it('hides the Data health tab when the user cannot manage', () => {
    renderPanel(false)
    expect(screen.getByText('Changes')).toBeInTheDocument()
    expect(screen.queryByText('Data health')).not.toBeInTheDocument()
  })

  it('shows the Data health tab when the user can manage', () => {
    renderPanel(true)
    expect(screen.getByText('Data health')).toBeInTheDocument()
  })
})
