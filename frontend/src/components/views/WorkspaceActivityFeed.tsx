/**
 * WorkspaceActivityFeed — "recent activity across all views" for the workspace
 * governance tab. Scoped by workspace_id; presentation comes from the shared
 * ActivityFeedList so it stays identical to the dashboard's feed.
 */
import { useWorkspaceViewActivity } from '@/hooks/useViewActivity'
import { ActivityFeedList } from '@/components/views/ActivityFeedList'

export function WorkspaceActivityFeed({ workspaceId }: { workspaceId: string }) {
    const { data, isLoading } = useWorkspaceViewActivity(workspaceId)

    return (
        <ActivityFeedList
            entries={data ?? []}
            isLoading={isLoading}
            emptyText="No recent activity across this workspace’s views."
        />
    )
}
