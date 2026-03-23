/**
 * Workspace landing page: /workspaces/:workspaceId
 * Sets the active workspace and renders the canvas with the default view.
 */
import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { useWorkspacesStore } from '@/store/workspaces'
import { useCanvasStore } from '@/store/canvas'

export function WorkspaceView() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { activeWorkspaceId, setActiveWorkspace } = useWorkspacesStore()
  const isLoading = useCanvasStore(s => s.isLoading)

  useEffect(() => {
    if (workspaceId && workspaceId !== activeWorkspaceId) {
      setActiveWorkspace(workspaceId)
    }
  }, [workspaceId, activeWorkspaceId, setActiveWorkspace])

  return (
    <div className="absolute inset-0">
      <CanvasRouter />
      {isLoading && (
        <div className="absolute bottom-4 left-4 glass-panel-subtle rounded-lg px-3 py-2 flex items-center gap-2 animate-fade-in">
          <div className="w-4 h-4 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-ink-secondary">Loading lineage...</span>
        </div>
      )}
    </div>
  )
}
