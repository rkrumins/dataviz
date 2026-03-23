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

export interface ScopeSwitchResult {
  workspaceChanged: boolean
  dataSourceChanged: boolean
}

/**
 * Switch the active workspace and datasource context to match a view's scope.
 * No-op if the current context already matches.
 *
 * Returns which dimensions actually changed so the caller knows whether to
 * wait for provider rebuild and schema reload.
 *
 * Handles the subtlety that `setActiveWorkspace()` auto-selects the primary
 * datasource — if the target datasource differs, we override with an explicit
 * `setActiveDataSource()` call afterward.
 */
export function switchToViewScope(workspaceId?: string, dataSourceId?: string): ScopeSwitchResult {
  const store = useWorkspacesStore.getState()
  const prevWsId = store.activeWorkspaceId
  const prevDsId = store.activeDataSourceId
  const needWsSwitch = !!(workspaceId && workspaceId !== prevWsId)

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

  const finalDsId = useWorkspacesStore.getState().activeDataSourceId
  return {
    workspaceChanged: needWsSwitch,
    dataSourceChanged: prevDsId !== finalDsId,
  }
}
