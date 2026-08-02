/**
 * The publish gate, resolved against the stores the app already has.
 *
 * Kept separate from {@link resolvePublishGate} so the rule stays a
 * pure, testable function and this file only does the plumbing:
 * platform ceiling + permission claim + workspace policy + the source's
 * restricted flag.
 *
 * Prefer the server's `access` envelope wherever a view has been
 * fetched — it is computed by the same evaluator that enforces every
 * request. This exists for the wizard, where no view exists yet, and as
 * the fallback for payloads that predate the envelope.
 */
import { useMemo } from 'react'

import {
    resolvePublishGate,
    type PlatformPublishPolicy,
    type PublishGate,
} from '@/lib/publishGate'
import { usePermission } from '@/store/auth'
import { useFeatureChoice } from '@/store/features'
import { useWorkspacesStore } from '@/store/workspaces'

const PLATFORM_POLICIES: readonly PlatformPublishPolicy[] = [
    'workspaces', 'request', 'off',
] as const

/** The deployment-wide ceiling on publishing. Exported because the
 *  Explorer's bulk action needs it without a specific workspace. */
export function usePlatformPublishPolicy(): PlatformPublishPolicy {
    return useFeatureChoice('enterpriseViewPolicy', PLATFORM_POLICIES) ?? 'workspaces'
}

export function usePublishGate(
    workspaceId?: string | null,
    dataSourceId?: string | null,
): PublishGate {
    const platformPolicy = usePlatformPublishPolicy()
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
            platformPolicy,
        })
    }, [hasPublishPermission, workspace, dataSourceId, platformPolicy])
}
