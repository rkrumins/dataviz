/**
 * useWorkspaceContext — composition hook that unifies workspace, view, bookmark,
 * and recent-views state into a single reactive object.
 *
 * This is a read-only composition layer over existing stores, NOT a new store.
 * It prevents each component from independently importing and composing 3-4 stores.
 */
import { useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWorkspacesStore } from '@/store/workspaces'
import { useSchemaStore } from '@/store/schema'
import { useBookmarkedViews } from '@/hooks/useBookmarkedViews'
import { useRecentViews, type RecentViewEntry } from '@/hooks/useRecentViews'
import type { WorkspaceResponse, DataSourceResponse } from '@/services/workspaceService'
import type { ViewConfiguration } from '@/types/schema'
import type { View } from '@/services/viewApiService'

const EMPTY_VIEWS: ViewConfiguration[] = []

export interface WorkspaceContext {
  // Identity
  workspace: WorkspaceResponse | null
  workspaceIndex: number
  dataSource: DataSourceResponse | null
  workspaces: WorkspaceResponse[]

  // Views for current scope
  views: ViewConfiguration[]
  activeView: ViewConfiguration | undefined
  activeViewId: string | null
  viewCount: number

  // All views (for cross-workspace search / counts)
  allViews: ViewConfiguration[]

  // Counts for all workspaces (for EnvironmentSwitcher badges)
  viewCountsByWorkspace: Map<string, number>
  viewCountsByScope: Map<string, number>

  // Quick access
  recentViews: RecentViewEntry[]
  bookmarks: View[]
  bookmarkedIds: Set<string>
  isLoadingBookmarks: boolean

  // Actions
  switchWorkspace: (wsId: string) => void
  switchDataSource: (dsId: string) => void
  openView: (viewId: string, wsId?: string, dsId?: string) => void
  toggleBookmark: (viewId: string, isCurrentlyBookmarked: boolean) => void
  recordVisit: (entry: Omit<RecentViewEntry, 'visitedAt'>) => void
}

export function useWorkspaceContext(): WorkspaceContext {
  const navigate = useNavigate()

  // ── Workspace store ──────────────────────────────────────
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
  const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace)
  const setActiveDataSource = useWorkspacesStore((s) => s.setActiveDataSource)

  const workspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId]
  )
  const workspaceIndex = useMemo(
    () => workspaces.findIndex((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId]
  )
  const dataSource = useMemo(
    () => workspace?.dataSources?.find((ds) => ds.id === activeDataSourceId) ?? null,
    [workspace, activeDataSourceId]
  )

  // ── Schema store ─────────────────────────────────────────
  const activeViewId = useSchemaStore((s) => s.activeViewId)
  const allViews = useSchemaStore((s) => s.schema?.views ?? EMPTY_VIEWS)

  // Call visibleViews inside useMemo to avoid creating new arrays on every render
  const visibleViewsFn = useSchemaStore((s) => s.visibleViews)
  const activeScopeKey = useSchemaStore((s) => s.activeScopeKey)
  const views = useMemo(() => visibleViewsFn(), [visibleViewsFn, activeScopeKey, allViews])

  const activeView = useMemo(
    () => (activeViewId ? allViews.find((v) => v.id === activeViewId) : undefined),
    [allViews, activeViewId]
  )

  // ── Bookmarks & Recent ──────────────────────────────────
  const { bookmarks, isLoading: isLoadingBookmarks, toggleBookmark } = useBookmarkedViews()
  const { recent: recentViews, recordVisit } = useRecentViews()

  const bookmarkedIds = useMemo(
    () => new Set(bookmarks.map((b) => b.id)),
    [bookmarks]
  )

  // ── Derived: view counts ────────────────────────────────
  const viewCountsByWorkspace = useMemo(() => {
    const counts = new Map<string, number>()
    for (const v of allViews) {
      if (v.workspaceId) {
        counts.set(v.workspaceId, (counts.get(v.workspaceId) ?? 0) + 1)
      }
    }
    return counts
  }, [allViews])

  const viewCountsByScope = useMemo(() => {
    const counts = new Map<string, number>()
    for (const v of allViews) {
      const key = v.scopeKey ?? (v.workspaceId ? `${v.workspaceId}/default` : null)
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }, [allViews])

  // ── Actions ─────────────────────────────────────────────
  const switchWorkspace = useCallback(
    (wsId: string) => {
      setActiveWorkspace(wsId)
      navigate(`/explorer?workspace=${encodeURIComponent(wsId)}`)
    },
    [setActiveWorkspace, navigate]
  )

  const switchDataSource = useCallback(
    (dsId: string) => {
      setActiveDataSource(dsId)
    },
    [setActiveDataSource]
  )

  const openView = useCallback(
    (viewId: string, _wsId?: string, _dsId?: string) => {
      // Do NOT call switchToViewScope() here — useViewNavigation in ViewPage
      // owns the full scope-switch → provider-rebuild → schema-reload pipeline.
      // Calling it here causes a race condition where useViewNavigation sees
      // the workspace already switched and skips waiting for the provider.
      // We also skip setActiveView() — useViewNavigation handles that after
      // the provider is ready.
      navigate(`/views/${viewId}`)
    },
    [navigate]
  )

  return {
    workspace,
    workspaceIndex,
    dataSource,
    workspaces,
    views,
    activeView,
    activeViewId,
    viewCount: views.length,
    allViews,
    viewCountsByWorkspace,
    viewCountsByScope,
    recentViews,
    bookmarks,
    bookmarkedIds,
    isLoadingBookmarks,
    switchWorkspace,
    switchDataSource,
    openView,
    toggleBookmark,
    recordVisit,
  }
}
