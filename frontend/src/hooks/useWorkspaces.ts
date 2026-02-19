/**
 * useWorkspaces — convenience hook for workspace management.
 *
 * Wraps useWorkspacesStore and workspaceService with loading/error state
 * and action helpers so components don't need to import both.
 */
import { useCallback, useState } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
import { workspaceService, type WorkspaceCreateRequest, type WorkspaceUpdateRequest } from '@/services/workspaceService'

export function useWorkspaces() {
    const store = useWorkspacesStore()
    const [actionLoading, setActionLoading] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const clearError = useCallback(() => setActionError(null), [])

    const createWorkspace = useCallback(async (req: WorkspaceCreateRequest) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const ws = await workspaceService.create(req)
            store.addWorkspace(ws)
            return ws
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to create workspace'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const updateWorkspace = useCallback(async (id: string, req: WorkspaceUpdateRequest) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const ws = await workspaceService.update(id, req)
            store.updateWorkspace(ws)
            return ws
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to update workspace'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const deleteWorkspace = useCallback(async (id: string) => {
        setActionLoading(true)
        setActionError(null)
        try {
            await workspaceService.delete(id)
            store.removeWorkspace(id)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to delete workspace'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const setDefault = useCallback(async (id: string) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const ws = await workspaceService.setDefault(id)
            await store.loadWorkspaces()
            return ws
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to set default workspace'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    return {
        workspaces: store.workspaces,
        activeWorkspaceId: store.activeWorkspaceId,
        activeWorkspace: store.getActiveWorkspace(),
        defaultWorkspace: store.getDefaultWorkspace(),
        isLoading: store.isLoading,
        loadError: store.error,
        actionLoading,
        actionError,
        clearError,
        loadWorkspaces: store.loadWorkspaces,
        setActiveWorkspace: store.setActiveWorkspace,
        createWorkspace,
        updateWorkspace,
        deleteWorkspace,
        setDefault,
    }
}
