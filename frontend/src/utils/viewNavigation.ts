/**
 * View navigation helpers — ensure the correct workspace + datasource
 * context is active before loading a view's graph data.
 */
import { useWorkspacesStore } from '@/store/workspaces'

/**
 * Extract dataSourceId from a scopeKey of format "workspaceId/dataSourceId".
 * Returns undefined if the scopeKey is null/undefined or the datasource
 * segment is the literal string "default".
 */
export function parseDataSourceId(scopeKey?: string | null): string | undefined {
  if (!scopeKey) return undefined
  const parts = scopeKey.split('/')
  if (parts.length < 2) return undefined
  const dsId = parts[1]
  return dsId && dsId !== 'default' ? dsId : undefined
}

/**
 * Switch the active workspace and datasource context to match a view's scope.
 * No-op if the current context already matches.
 *
 * Handles the subtlety that `setActiveWorkspace()` auto-selects the primary
 * datasource — if the target datasource differs, we override with an explicit
 * `setActiveDataSource()` call afterward.
 */
export function switchToViewScope(workspaceId?: string, dataSourceId?: string): void {
  const store = useWorkspacesStore.getState()
  const needWsSwitch = workspaceId && workspaceId !== store.activeWorkspaceId

  if (needWsSwitch) {
    // setActiveWorkspace resets activeDataSourceId to the workspace's primary
    store.setActiveWorkspace(workspaceId)

    // Check if the auto-selected datasource matches the target; override if not
    if (dataSourceId && dataSourceId !== useWorkspacesStore.getState().activeDataSourceId) {
      store.setActiveDataSource(dataSourceId)
    }
  } else if (dataSourceId && dataSourceId !== store.activeDataSourceId) {
    // Same workspace, different datasource
    store.setActiveDataSource(dataSourceId)
  }
}
