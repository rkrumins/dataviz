/**
 * Which workspaces' data a template can be previewed with: the ones whose data
 * the caller can read, each through its primary source.
 */
import { useMemo } from 'react'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { checkPermission, usePermissionClaims } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

/** The workspaces whose data the caller can read — what a template can be previewed with. */
export function useFitWorkspaces(): WorkspaceResponse[] {
    const claims = usePermissionClaims()
    const workspaces = useWorkspacesStore(s => s.workspaces)
    return useMemo(
        () => workspaces.filter(ws => ws.dataSources.length > 0 && checkPermission(claims, 'workspace:datasource:read', ws.id)),
        [workspaces, claims],
    )
}

/** The source a workspace's data is read from for a preview: its primary. */
export function primarySource(workspace: WorkspaceResponse) {
    return workspace.dataSources.find(d => d.isPrimary) ?? workspace.dataSources[0]
}
