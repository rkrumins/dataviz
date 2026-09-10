/**
 * The workspace deletion flow — impact fetch, honest copy, and the delete itself.
 *
 * Deleting a workspace is the most destructive button on the page and it was
 * guarded by `confirm('Delete this workspace and all its data sources?')`. That
 * sentence is wrong by omission: the backend cascade also HARD-deletes every VIEW
 * in the workspace (`views.workspace_id` is ON DELETE CASCADE), including views
 * already soft-deleted and waiting to be restored, plus every member's access and
 * any workspace-scoped custom roles. A user could destroy a colleague's dashboards
 * from a one-line prompt that never mentioned them.
 *
 * Bulk is the same flow with the impacts summed — and it is a CLIENT-SIDE FAN-OUT,
 * because no bulk endpoint exists. That matters for honesty: a partial failure
 * leaves some workspaces deleted, so we report what actually happened rather than
 * pretending it was atomic.
 */
import { useCallback, useState } from 'react'
import {
    workspaceService,
    type WorkspaceResponse,
    type WorkspaceImpactResponse,
} from '@/services/workspaceService'
import type { ImpactSection } from '@/components/ui/DangerConfirmDialog'
import { useAppNotifications } from '@/components/ui/notifications'

/** What the delete does NOT do. Silence here is how orphans are born. */
export const DELETE_CAVEAT =
    'The underlying graph data stays in its provider — deleting a workspace does not '
    + 'purge it. Connected catalog items are released and can be attached to another '
    + 'workspace.'

export function impactSections(impact: WorkspaceImpactResponse | null): ImpactSection[] {
    if (!impact) return []
    return [
        {
            label: impact.views.length === 1 ? 'View' : 'Views',
            // Not "removed" — the workspace cascade bypasses the soft-delete path
            // the Explorer uses, so there is no Restore afterwards.
            consequence: 'permanently deleted, with no restore',
            count: impact.views.length,
            items: impact.views,
        },
        {
            label: impact.dataSources.length === 1 ? 'Data source' : 'Data sources',
            consequence: 'disconnected',
            count: impact.dataSources.length,
            items: impact.dataSources,
        },
        {
            label: impact.memberCount === 1 ? 'Member' : 'Members',
            consequence: 'lose access',
            count: impact.memberCount,
        },
        {
            label: impact.customRoleCount === 1 ? 'Custom role' : 'Custom roles',
            consequence: 'deleted',
            count: impact.customRoleCount,
        },
    ]
}

function mergeImpacts(impacts: WorkspaceImpactResponse[]): WorkspaceImpactResponse {
    return {
        views: impacts.flatMap(i => i.views),
        dataSources: impacts.flatMap(i => i.dataSources),
        memberCount: impacts.reduce((n, i) => n + i.memberCount, 0),
        customRoleCount: impacts.reduce((n, i) => n + i.customRoleCount, 0),
    }
}

export interface DeletionTarget {
    /** The workspaces about to be destroyed. */
    workspaces: WorkspaceResponse[]
    impact: WorkspaceImpactResponse | null
    loading: boolean
}

export function useWorkspaceDeletion(onDeleted: () => void) {
    const [target, setTarget] = useState<DeletionTarget | null>(null)
    const { notify } = useAppNotifications()

    const open = useCallback(async (workspaces: WorkspaceResponse[]) => {
        if (workspaces.length === 0) return
        setTarget({ workspaces, impact: null, loading: true })

        // One impact call per workspace — there is no bulk impact endpoint, and a
        // failed probe must NOT silently read as "nothing will be destroyed", so a
        // rejection surfaces as an unknown impact rather than an empty one.
        const results = await Promise.allSettled(
            workspaces.map(w => workspaceService.getImpact(w.id)),
        )
        const ok = results
            .filter((r): r is PromiseFulfilledResult<WorkspaceImpactResponse> => r.status === 'fulfilled')
            .map(r => r.value)

        if (ok.length !== workspaces.length) {
            setTarget({ workspaces, impact: null, loading: false })
            return
        }

        setTarget({ workspaces, impact: mergeImpacts(ok), loading: false })
    }, [])

    const close = useCallback(() => setTarget(null), [])

    const confirm = useCallback(async () => {
        if (!target) return

        // Client-side fan-out: no bulk endpoint exists. Report partial failure
        // truthfully instead of claiming an atomic delete we didn't perform.
        const results = await Promise.allSettled(
            target.workspaces.map(w => workspaceService.delete(w.id)),
        )
        const failed = results.filter(r => r.status === 'rejected').length

        onDeleted()

        if (failed > 0) {
            // The dialog stays open and shows this — a partial fan-out must NEVER
            // also raise a success notification saying the deletion went through.
            throw new Error(
                failed === target.workspaces.length
                    ? 'Delete failed. Nothing was deleted.'
                    : `${target.workspaces.length - failed} deleted, ${failed} failed. The list has been refreshed.`,
            )
        }

        notify('success', target.workspaces.length === 1
            ? `Deleted “${target.workspaces[0].name}” — its views, members and custom roles went with it.`
            : `Deleted ${target.workspaces.length} workspaces — their views, members and custom roles went with them.`)
    }, [target, onDeleted, notify])

    return { target, open, close, confirm }
}
