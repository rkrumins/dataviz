/**
 * Foreign-view open path: a shared/enterprise view must open for a
 * caller whose (RBAC-scoped) workspace list does NOT contain the
 * view's workspace. The old hook errored with "The workspace for this
 * view no longer exists." for exactly the people the view was shared
 * with.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/viewApiService', async () => {
  const actual = await vi.importActual<typeof import('@/services/viewApiService')>(
    '@/services/viewApiService',
  )
  return { ...actual, getView: vi.fn(), recordViewVisit: vi.fn().mockResolvedValue(undefined) }
})

import { getView, type View } from '@/services/viewApiService'
import { useViewNavigation } from '../useViewNavigation'
import { useWorkspacesStore } from '@/store/workspaces'
import { useSchemaStore } from '@/store/schema'

const mockGetView = vi.mocked(getView)

const FOREIGN_VIEW: View = {
  id: 'view_shared',
  name: 'Shared Lineage',
  workspaceId: 'ws_foreign',
  workspaceName: 'Finance (not mine)',
  dataSourceId: 'ds_primary',
  dataSourceName: 'Finance Graph',
  providerId: 'prov_1',
  viewType: 'graph',
  config: {},
  visibility: 'enterprise',
  isPinned: false,
  favouriteCount: 0,
  isFavourited: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  access: {
    canEdit: false,
    canManageGrants: false,
    canChangeVisibility: false,
    canPublish: false,
    accessVia: 'enterprise',
    dataAccess: 'readonly',
  },
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  mockGetView.mockReset()
  // The caller belongs to NO workspaces — the empty store is the point.
  useWorkspacesStore.setState({ workspaces: [] })
  useSchemaStore.setState(state => ({
    ...state,
    schema: state.schema ? { ...state.schema, views: [] } : state.schema,
  }))
})

describe('useViewNavigation — foreign (shared/enterprise) views', () => {
  it('opens a view whose workspace is absent from the store', async () => {
    mockGetView.mockResolvedValue(FOREIGN_VIEW)
    const { result } = renderHook(() => useViewNavigation('view_shared'), {
      wrapper: makeWrapper(),
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.error).toBeNull()
    expect(result.current.viewWorkspaceId).toBe('ws_foreign')
    // Server-resolved scope + names come from the response, not the store.
    expect(result.current.viewDataSourceId).toBe('ds_primary')
    expect(result.current.viewWorkspaceName).toBe('Finance (not mine)')
    expect(result.current.viewProviderId).toBe('prov_1')
    expect(result.current.access?.dataAccess).toBe('readonly')
  })

  it('requests the view with the AccessDeniedModal suppressed', async () => {
    mockGetView.mockResolvedValue(FOREIGN_VIEW)
    renderHook(() => useViewNavigation('view_shared'), { wrapper: makeWrapper() })
    await waitFor(() => expect(mockGetView).toHaveBeenCalled())
    expect(mockGetView).toHaveBeenCalledWith(
      'view_shared', undefined, { silent403: true },
    )
  })

  it('maps a 404 to the existence-hiding access copy', async () => {
    mockGetView.mockRejectedValue(new Error("View 'view_shared' not found"))
    const { result } = renderHook(() => useViewNavigation('view_shared'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatch(/hasn't been shared with you/i)
  })

  it('keeps the dedicated backend-error copy on 500s', async () => {
    mockGetView.mockRejectedValue(new Error('HTTP 500: internal error'))
    const { result } = renderHook(() => useViewNavigation('view_shared'), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatch(/backend returned an error/i)
  })
})
