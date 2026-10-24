/**
 * ViewVersioningPanel — pins the gating of the "Data health" tab: everyone can see where the graph
 * lives and whether it is in sync, and only `canManage` gets its actions. The panel's tab bodies and
 * data hooks are stubbed so the test stays focused on which tabs render.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../hooks/useVersioning', () => ({
  useBranchDiffSummary: () => ({ data: undefined, isLoading: false }),
  useBranchViewChanges: () => ({ data: undefined, isLoading: false }),
}))
vi.mock('@/services/versioningApiService', () => ({ getBranchDiffChildren: vi.fn() }))
vi.mock('@/store/stagedChangesStore', () => ({
  useStagedChangesStore: (sel: (s: unknown) => unknown) => sel({ changes: [], openReviewPanel: vi.fn() }),
}))
vi.mock('../ChangeTreePanel', () => ({ ChangeTreePanel: () => null }))
vi.mock('../../../reviews/components/ViewPrList', () => ({ ViewPrList: () => null }))
vi.mock('../ViewHistoryTimeline', () => ({ ViewHistoryTimeline: () => null }))
vi.mock('../DataHealthTab', () => ({
  DataHealthTab: ({ canManage }: { canManage: boolean }) => <div>data-health-body {canManage ? 'manage' : 'read-only'}</div>,
}))

import { ViewVersioningPanel } from '../ViewVersioningPanel'

const renderPanel = (canManage: boolean) =>
  render(
    <ViewVersioningPanel wsId="ws1" graphId="g1" branchId={null} canManage={canManage} onClose={() => {}} />,
  )

describe('ViewVersioningPanel — Data health tab gating', () => {
  it('shows a read-only Data health tab when the user cannot manage', () => {
    renderPanel(false)
    expect(screen.getByText('Changes')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Data health'))
    expect(screen.getByText('data-health-body read-only')).toBeInTheDocument()
  })

  it('shows the Data health tab with its actions when the user can manage', () => {
    renderPanel(true)
    fireEvent.click(screen.getByText('Data health'))
    expect(screen.getByText('data-health-body manage')).toBeInTheDocument()
  })
})
