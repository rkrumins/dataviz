/**
 * WorkspaceSelector — dropdown in the top bar for switching the active workspace.
 *
 * When only one workspace exists it renders a static label.
 * When multiple workspaces exist it renders a select dropdown.
 * When the active workspace has multiple data sources, a second
 * selector appears to pick the active data source.
 * Clicking "Manage" opens the WorkspacePanel (passed as onManage callback).
 */
import { type FC } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'

interface WorkspaceSelectorProps {
    /** Called when the user clicks "Manage workspaces" */
    onManage?: () => void
    className?: string
}

export const WorkspaceSelector: FC<WorkspaceSelectorProps> = ({ onManage, className }) => {
    const workspaces = useWorkspacesStore((s) => s.workspaces)
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
    const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace)
    const setActiveDataSource = useWorkspacesStore((s) => s.setActiveDataSource)
    const isLoading = useWorkspacesStore((s) => s.isLoading)

    if (isLoading) {
        return (
            <div className={`flex items-center gap-2 text-sm text-muted-foreground ${className ?? ''}`}>
                <span className="animate-pulse">Loading workspaces...</span>
            </div>
        )
    }

    if (workspaces.length === 0) {
        return (
            <div className={`flex items-center gap-2 text-sm ${className ?? ''}`}>
                <span className="text-muted-foreground">No workspaces</span>
                {onManage && (
                    <button
                        onClick={onManage}
                        className="text-xs text-primary underline underline-offset-2 hover:no-underline"
                    >
                        Create one
                    </button>
                )}
            </div>
        )
    }

    const active = workspaces.find((w) => w.id === activeWorkspaceId)
    const dataSources = active?.dataSources ?? []
    const showDsSelector = dataSources.length > 1

    return (
        <div className={`flex items-center gap-2 text-sm ${className ?? ''}`}>
            {workspaces.length === 1 ? (
                // Single workspace — static label
                <span className="font-medium">
                    {active?.name ?? workspaces[0].name}
                </span>
            ) : (
                // Multiple workspaces — dropdown
                <select
                    value={activeWorkspaceId ?? ''}
                    onChange={(e) => setActiveWorkspace(e.target.value || null)}
                    className="rounded border border-border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Active workspace"
                >
                    {workspaces.map((ws) => (
                        <option key={ws.id} value={ws.id}>
                            {ws.name}
                            {ws.isDefault ? ' (default)' : ''}
                        </option>
                    ))}
                </select>
            )}

            {/* Data source sub-selector — only shown when workspace has multiple sources */}
            {showDsSelector && (
                <select
                    value={activeDataSourceId ?? ''}
                    onChange={(e) => setActiveDataSource(e.target.value || null)}
                    className="rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Active data source"
                >
                    {dataSources.map((ds) => (
                        <option key={ds.id} value={ds.id}>
                            {ds.label || ds.graphName || ds.providerId}
                            {ds.isPrimary ? ' (primary)' : ''}
                        </option>
                    ))}
                </select>
            )}

            {/* Single data source — show graph name inline */}
            {!showDsSelector && dataSources.length === 1 && dataSources[0].graphName && (
                <span className="text-xs text-muted-foreground">
                    ({dataSources[0].label || dataSources[0].graphName})
                </span>
            )}

            {onManage && (
                <button
                    onClick={onManage}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Manage workspaces"
                >
                    Manage
                </button>
            )}
        </div>
    )
}
