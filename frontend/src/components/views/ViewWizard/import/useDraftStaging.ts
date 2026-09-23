/**
 * Whether an import can wait in a draft instead of going live at once: its data source is under
 * version control (with version control on here), and the person may open drafts on it
 * (`workspace:datasource:manage`, as the draft switcher requires).
 */
import { useQueries } from '@tanstack/react-query'
import { useFeature } from '@/store/features'
import { checkPermission, usePermission, usePermissionClaims } from '@/store/auth'
import { VERSIONING_KEYS, useResolveGraph } from '@/features/versioning/hooks/useVersioning'
import { resolveGraph } from '@/services/versioningApiService'

export const DRAFT_PERMISSION = 'workspace:datasource:manage'

export interface DraftStaging {
  /** The data source is under version control: there is a choice to make at all. */
  versioned: boolean
  /** ...and this person may open drafts on it. */
  allowed: boolean
  checking: boolean
}

export function useDraftStaging(workspaceId?: string | null, dataSourceId?: string | null): DraftStaging {
  const versioningOn = useFeature('versioningEnabled')
  const allowed = usePermission(DRAFT_PERMISSION, workspaceId)
  const resolved = useResolveGraph(workspaceId ?? undefined, versioningOn ? dataSourceId : null)
  return { versioned: versioningOn && !!resolved.data?.graphId, allowed, checking: resolved.isLoading }
}

/** The same, for each of several targets at once (a file of several views), keyed by data source. */
export function useDraftStagingFor(targets: Array<{ workspaceId: string; dataSourceId: string | null }>): Record<string, DraftStaging> {
  const versioningOn = useFeature('versioningEnabled')
  const claims = usePermissionClaims()
  const unique = [...new Map(targets.filter(t => t.dataSourceId).map(t => [t.dataSourceId!, t])).values()]
  const results = useQueries({
    queries: unique.map(t => ({
      queryKey: VERSIONING_KEYS.resolve(t.workspaceId, t.dataSourceId),
      queryFn: () => resolveGraph(t.workspaceId, t.dataSourceId!),
      enabled: versioningOn,
      staleTime: 300_000,
      retry: false,
    })),
  })
  return Object.fromEntries(unique.map((t, i) => [t.dataSourceId!, {
    versioned: versioningOn && !!results[i]?.data?.graphId,
    allowed: checkPermission(claims, DRAFT_PERMISSION, t.workspaceId),
    checking: !!results[i]?.isLoading,
  }]))
}
