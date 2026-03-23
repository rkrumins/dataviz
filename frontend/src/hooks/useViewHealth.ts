/**
 * useViewHealth — Cross-references views against workspace/datasource stores
 * to detect broken, stale, or warning views.
 *
 * Computed client-side from existing Zustand store data — no new API calls.
 */
import { useMemo } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
import type { View } from '@/services/viewApiService'

export type HealthStatus = 'healthy' | 'warning' | 'broken' | 'stale'

export interface ViewHealthInfo {
  status: HealthStatus
  reason?: string
}

const STALE_THRESHOLD_DAYS = 90

export function useViewHealth(views: View[]): Map<string, ViewHealthInfo> {
  const workspaces = useWorkspacesStore(s => s.workspaces)

  return useMemo(() => {
    const healthMap = new Map<string, ViewHealthInfo>()
    const wsMap = new Map(workspaces.map(ws => [ws.id, ws]))

    for (const view of views) {
      const ws = wsMap.get(view.workspaceId)

      // Check if workspace exists
      if (!ws) {
        healthMap.set(view.id, { status: 'broken', reason: 'Workspace no longer exists' })
        continue
      }

      // Check if workspace is active
      if (!ws.isActive) {
        healthMap.set(view.id, { status: 'warning', reason: 'Workspace is inactive' })
        continue
      }

      // Check if data source exists (if view references one)
      if (view.dataSourceId) {
        const ds = ws.dataSources?.find(d => d.id === view.dataSourceId)
        if (!ds) {
          healthMap.set(view.id, { status: 'broken', reason: 'Data source no longer exists' })
          continue
        }
        if (!ds.isActive) {
          healthMap.set(view.id, { status: 'warning', reason: 'Data source is inactive' })
          continue
        }
      }

      // Check for staleness
      const updatedAt = new Date(view.updatedAt)
      const daysSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSinceUpdate > STALE_THRESHOLD_DAYS) {
        healthMap.set(view.id, { status: 'stale', reason: `Not updated in ${Math.floor(daysSinceUpdate)} days` })
        continue
      }

      healthMap.set(view.id, { status: 'healthy' })
    }

    return healthMap
  }, [views, workspaces])
}
