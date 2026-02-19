/**
 * WorkspaceSelector — dropdown in the top bar for switching the active workspace.
 *
 * When only one workspace exists it renders a static label.
 * When multiple workspaces exist it renders a select dropdown.
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
    const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace)
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

    return (
        <div className={`flex items-center gap-2 text-sm ${className ?? ''}`}>
            {workspaces.length === 1 ? (
                // Single workspace — static label
                <span className="font-medium">
                    {active?.name ?? workspaces[0].name}
                    {(active?.graphName ?? workspaces[0].graphName) && (
                        <span className="ml-1 text-xs text-muted-foreground">
                            ({active?.graphName ?? workspaces[0].graphName})
                        </span>
                    )}
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
                            {ws.graphName ? ` · ${ws.graphName}` : ''}
                        </option>
                    ))}
                </select>
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
