/**
 * The publish gate, resolved against the stores the wizard already has.
 *
 * Kept separate from {@link resolvePublishGate} so the rule stays a
 * pure, testable function and this file only does the plumbing:
 * permission claim + workspace policy + the source's restricted flag.
 */
import { useMemo } from 'react'

import { resolvePublishGate, type PublishGate } from '@/lib/publishGate'
import { usePermission } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'

export function usePublishGate(
    workspaceId?: string | null,
    dataSourceId?: string | null,
): PublishGate {
    const hasPublishPermission = usePermission(
        'workspace:view:publish', workspaceId ?? undefined,
    )
    const workspace = useWorkspacesStore(
        s => s.workspaces.find(w => w.id === workspaceId) ?? null,
    )

    return useMemo(() => {
        // No explicit source means the workspace's primary — the same
        // fallback the backend resolves a view's source with.
        const sources = workspace?.dataSources ?? []
        const source = dataSourceId
            ? sources.find(d => d.id === dataSourceId)
            : sources.find(d => d.isPrimary) ?? sources[0]

        return resolvePublishGate({
            hasPublishPermission,
            publishPolicy: workspace?.publishPolicy,
            sourceRestricted: source?.isRestricted,
        })
    }, [hasPublishPermission, workspace, dataSourceId])
}
