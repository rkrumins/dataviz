/**
 * View health — read from the server, never recomputed here.
 *
 * This module used to cross-reference each view against `useWorkspacesStore`
 * and decide for itself whether the view was broken. That could not be right:
 * `GET /workspaces` returns only the workspaces the caller holds a binding in,
 * and `enterprise` / `public` views exist for people who hold no such binding.
 * For exactly the audience those tiers were built for, the lookup always
 * missed — and a miss was reported as `broken` / "Workspace no longer exists",
 * which the Explorer card then rendered as the literal string "Source
 * deleted". Nothing had been deleted, and the view's owner saw it as healthy
 * at the same moment.
 *
 * Health is a property of the view, not of whoever is looking at it, so it is
 * resolved server-side from the view's OWN workspace and data source and
 * arrives on the DTO. The hook remains only to shape those fields into the map
 * the existing call sites index by view id.
 */
import { useMemo } from 'react'
import type { View } from '@/services/viewApiService'

export type HealthStatus = 'healthy' | 'warning' | 'broken' | 'stale'

export interface ViewHealthInfo {
  status: HealthStatus
  reason?: string
}

export function useViewHealth(views: View[]): Map<string, ViewHealthInfo> {
  return useMemo(() => {
    const healthMap = new Map<string, ViewHealthInfo>()
    for (const view of views) {
      healthMap.set(view.id, {
        status: (view.healthStatus ?? 'healthy') as HealthStatus,
        reason: view.healthReason ?? undefined,
      })
    }
    return healthMap
  }, [views])
}
