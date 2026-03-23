/**
 * useConnections — convenience hook for connection management.
 *
 * Wraps useConnectionsStore and connectionService with loading/error state
 * and action helpers so components don't need to import both.
 */
import { useCallback, useState } from 'react'
import { useConnectionsStore } from '@/store/connections'
import { connectionService, type ConnectionCreateRequest, type ConnectionUpdateRequest } from '@/services/connectionService'

export function useConnections() {
    const store = useConnectionsStore()
    const [actionLoading, setActionLoading] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const clearError = useCallback(() => setActionError(null), [])

    const createConnection = useCallback(async (req: ConnectionCreateRequest) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const conn = await connectionService.create(req)
            store.addConnection(conn)
            return conn
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to create connection'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const updateConnection = useCallback(async (id: string, req: ConnectionUpdateRequest) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const conn = await connectionService.update(id, req)
            store.updateConnection(conn)
            return conn
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to update connection'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const deleteConnection = useCallback(async (id: string) => {
        setActionLoading(true)
        setActionError(null)
        try {
            await connectionService.delete(id)
            store.removeConnection(id)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to delete connection'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    const testConnection = useCallback(async (id: string) => {
        setActionLoading(true)
        setActionError(null)
        try {
            return await connectionService.test(id)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Connection test failed'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [])

    const setPrimary = useCallback(async (id: string) => {
        setActionLoading(true)
        setActionError(null)
        try {
            const conn = await connectionService.setPrimary(id)
            // Refresh the full list so isPrimary flags are updated
            await store.loadConnections()
            return conn
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to set primary connection'
            setActionError(msg)
            throw err
        } finally {
            setActionLoading(false)
        }
    }, [store])

    return {
        connections: store.connections,
        activeConnectionId: store.activeConnectionId,
        activeConnection: store.getActiveConnection(),
        primaryConnection: store.getPrimaryConnection(),
        isLoading: store.isLoading,
        loadError: store.error,
        actionLoading,
        actionError,
        clearError,
        loadConnections: store.loadConnections,
        setActiveConnection: store.setActiveConnection,
        createConnection,
        updateConnection,
        deleteConnection,
        testConnection,
        setPrimary,
    }
}
