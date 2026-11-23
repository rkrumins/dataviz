/**
 * useViewHealth: the server's verdict wins; a view it never judged is stale only when nothing
 * changed in 90 days — settings or data, as the server's "needs attention" judges it. A view
 * whose data is published every week is not stale for settings untouched since spring.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWorkspacesStore } from '@/store/workspaces'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { View } from '@/services/viewApiService'
import { useViewHealth } from '../useViewHealth'

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

function view(id: string, overrides: Partial<View> = {}): View {
  return {
    id, name: id, workspaceId: 'ws_1', viewType: 'graph', config: {}, visibility: 'workspace',
    isPinned: false, favouriteCount: 0, isFavourited: false,
    createdAt: daysAgo(400), updatedAt: daysAgo(200), ...overrides,
  }
}

beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [{
      id: 'ws_1', name: 'Finance', isDefault: true, isActive: true,
      createdAt: daysAgo(400), updatedAt: daysAgo(400), dataSources: [],
    } satisfies WorkspaceResponse],
  })
})

describe('useViewHealth', () => {
  it('judges staleness on the last change, settings or data', () => {
    const { result } = renderHook(() => useViewHealth([
      view('fed', { dataUpdatedAt: daysAgo(7) }),
      view('idle', { dataUpdatedAt: daysAgo(150) }),
      view('never_published'),
      view('edited', { updatedAt: daysAgo(3) }),
    ]))
    expect(result.current.get('fed')).toEqual({ status: 'healthy' })
    expect(result.current.get('idle')).toEqual({ status: 'stale', reason: 'Not updated in 150 days' })
    expect(result.current.get('never_published')?.status).toBe('stale')
    expect(result.current.get('edited')).toEqual({ status: 'healthy' })
  })

  it('takes the server’s verdict whenever it gave one', () => {
    const { result } = renderHook(() => useViewHealth([
      view('judged', { dataUpdatedAt: daysAgo(1), health: { status: 'warning', reason: 'Data source is inactive' } }),
    ]))
    expect(result.current.get('judged')).toEqual({ status: 'warning', reason: 'Data source is inactive' })
  })
})
