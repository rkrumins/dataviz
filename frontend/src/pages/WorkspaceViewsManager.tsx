/**
 * Workspace views management page: /workspaces/:workspaceId/views
 * CRUD interface for managing views owned by a workspace.
 */
import { useEffect, useState, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { Plus, Trash2, Eye, Globe, Lock, Users, Heart, Pencil, MoreHorizontal } from 'lucide-react'
import { viewsApi, type ViewApiResponse } from '@/services/viewsApiService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useViewEditorModal } from '@/components/layout/AppLayout'

export function WorkspaceViewsManager() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const navigate = useNavigate()
  const { activeWorkspaceId, setActiveWorkspace, workspaces } = useWorkspacesStore()
  const { openViewEditor } = useViewEditorModal()

  const [views, setViews] = useState<ViewApiResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const workspace = workspaces.find(ws => ws.id === workspaceId)

  // Set workspace as active
  useEffect(() => {
    if (workspaceId && workspaceId !== activeWorkspaceId) {
      setActiveWorkspace(workspaceId)
    }
  }, [workspaceId, activeWorkspaceId, setActiveWorkspace])

  const fetchViews = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    try {
      const data = await viewsApi.list({ workspaceId })
      setViews(data)
    } catch (err) {
      console.error('[WorkspaceViewsManager] Failed to load views:', err)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => { fetchViews() }, [fetchViews])

  const handleDelete = async (viewId: string) => {
    try {
      await viewsApi.delete(viewId)
      setDeleteConfirm(null)
      fetchViews()
    } catch (err) {
      console.error('Failed to delete view:', err)
    }
  }

  const handleVisibilityChange = async (viewId: string, visibility: 'private' | 'workspace' | 'enterprise') => {
    try {
      await viewsApi.updateVisibility(viewId, visibility)
      fetchViews()
    } catch (err) {
      console.error('Failed to update visibility:', err)
    }
  }

  const visibilityOptions = [
    { value: 'private', label: 'Private', icon: Lock },
    { value: 'workspace', label: 'Workspace', icon: Users },
    { value: 'enterprise', label: 'Enterprise', icon: Globe },
  ] as const

  return (
    <div className="absolute inset-0 overflow-y-auto bg-canvas p-6">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-ink-primary">
              {workspace?.name || 'Workspace'} — Views
            </h1>
            <p className="text-sm text-ink-secondary mt-1">
              Manage views for this workspace. Changes are reflected across all shared links.
            </p>
          </div>
          <button
            onClick={() => openViewEditor()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-lineage text-white text-sm font-medium hover:bg-accent-lineage/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New View
          </button>
        </div>

        {/* Views table */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
          </div>
        ) : views.length === 0 ? (
          <div className="text-center py-20">
            <Eye className="w-12 h-12 text-ink-faint mx-auto mb-4" />
            <p className="text-ink-secondary text-sm">No views yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {views.map(view => (
              <div
                key={view.id}
                className="glass-panel rounded-lg p-4 flex items-center gap-4 group hover:border-accent-lineage/30 transition-all"
              >
                {/* Name & description */}
                <div className="flex-1 min-w-0">
                  <Link
                    to={`/views/${view.id}`}
                    className="text-sm font-medium text-ink-primary hover:text-accent-lineage transition-colors"
                  >
                    {view.name}
                  </Link>
                  {view.description && (
                    <p className="text-xs text-ink-secondary truncate mt-0.5">{view.description}</p>
                  )}
                </div>

                {/* Tags */}
                <div className="flex items-center gap-1">
                  {view.tags?.slice(0, 2).map(tag => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-chrome-100 text-ink-secondary">
                      {tag}
                    </span>
                  ))}
                </div>

                {/* Favourites */}
                <div className="flex items-center gap-1 text-ink-faint">
                  <Heart className="w-3 h-3" />
                  <span className="text-xs">{view.favouriteCount}</span>
                </div>

                {/* Visibility selector */}
                <select
                  value={view.visibility}
                  onChange={e => handleVisibilityChange(view.id, e.target.value as any)}
                  className="text-xs bg-chrome-50 border border-chrome-200 rounded px-2 py-1 text-ink-secondary"
                >
                  {visibilityOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openViewEditor(view.id)}
                    className="p-1.5 rounded hover:bg-chrome-100 text-ink-secondary"
                    title="Edit"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(view.id)}
                    className="p-1.5 rounded hover:bg-red-500/10 text-ink-secondary hover:text-red-500"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Updated timestamp */}
                <span className="text-[10px] text-ink-faint whitespace-nowrap">
                  {new Date(view.updatedAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Delete confirmation */}
        {deleteConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="glass-panel rounded-xl p-6 max-w-sm w-full mx-4">
              <h3 className="text-sm font-semibold text-ink-primary mb-2">Delete View</h3>
              <p className="text-xs text-ink-secondary mb-4">
                Are you sure? This will remove the view and break any shared links.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="px-3 py-1.5 rounded-lg text-xs text-ink-secondary hover:bg-chrome-100"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(deleteConfirm)}
                  className="px-3 py-1.5 rounded-lg text-xs bg-red-500 text-white hover:bg-red-600"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
