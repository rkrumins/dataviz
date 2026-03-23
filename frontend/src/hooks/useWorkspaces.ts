/**
 * useWorkspaces — convenience hook for workspace management.
 *
 * Wraps useWorkspacesStore and workspaceService with loading/error state
 * and action helpers so components don't need to import both.
 * Includes data source management actions for multi-source workspaces.
 */
import { useCallback, useState } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
import {
    workspaceService,
    type WorkspaceCreateRequest,
    type WorkspaceUpdateRequest,
    type DataSourceCreateRequest,
    type DataSourceUpdateRequest,
} from '@/services/workspaceService'

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

    // ── Data Source Actions ──────────────────────────────────

    const addDataSource = useCallback(async (wsId: string, req: DataSourceCreateRequest) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const ds = await workspaceService.addDataSource(wsId, req)
            await store.loadWorkspaces()
            return ds
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to add data source'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const updateDataSource = useCallback(async (wsId: string, dsId: string, req: DataSourceUpdateRequest) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const ds = await workspaceService.updateDataSource(wsId, dsId, req)
            await store.loadWorkspaces()
            return ds
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to update data source'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const removeDataSource = useCallback(async (wsId: string, dsId: string) => {
        setActionLoading(true)
        setActionError(null)
        try {
            await workspaceService.removeDataSource(wsId, dsId)
            await store.loadWorkspaces()
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to remove data source'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const setPrimaryDataSource = useCallback(async (wsId: string, dsId: string) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const ds = await workspaceService.setPrimaryDataSource(wsId, dsId)
            await store.loadWorkspaces()
            return ds
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to set primary data source'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    return {
        workspaces: store.workspaces,
        activeWorkspaceId: store.activeWorkspaceId,
        activeDataSourceId: store.activeDataSourceId,
        activeWorkspace: store.getActiveWorkspace(),
        activeDataSource: store.getActiveDataSource(),
        defaultWorkspace: store.getDefaultWorkspace(),
        isLoading: store.isLoading,
        loadError: store.error,
        actionLoading,
        actionError,
        clearError,
        loadWorkspaces: store.loadWorkspaces,
        setActiveWorkspace: store.setActiveWorkspace,
        setActiveDataSource: store.setActiveDataSource,
        createWorkspace,
        updateWorkspace,
        deleteWorkspace,
        setDefault,
        addDataSource,
        updateDataSource,
        removeDataSource,
        setPrimaryDataSource,
    }
}
