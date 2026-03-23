/**
 * Connections store — manages the list of registered graph database connections
 * and tracks the active connection for the current session.
 *
 * Only `activeConnectionId` is persisted to localStorage so that the user's
 * last-selected connection is restored on reload.  The connection list itself
 * is always loaded fresh from the backend.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { connectionService, type ConnectionResponse } from '@/services/connectionService'

interface ConnectionsState {
    connections: ConnectionResponse[]
    activeConnectionId: string | null
    isLoading: boolean
    error: string | null

    // Actions
    loadConnections: () => Promise<void>
    setActiveConnection: (id: string | null) => void
    getPrimaryConnection: () => ConnectionResponse | null
    getActiveConnection: () => ConnectionResponse | null

    // Mutation helpers (called after CRUD from ConnectionsPanel)
    addConnection: (conn: ConnectionResponse) => void
    updateConnection: (conn: ConnectionResponse) => void
    removeConnection: (id: string) => void
}

export const useConnectionsStore = create<ConnectionsState>()(
    persist(
        (set, get) => ({
            connections: [],
            activeConnectionId: null,
            isLoading: false,
            error: null,

            loadConnections: async () => {
                set({ isLoading: true, error: null })
                try {
                    const connections = await connectionService.list()
                    set({ connections, isLoading: false })

                    // Auto-select: keep existing if still valid, otherwise use primary
                    const { activeConnectionId } = get()
                    const stillExists = connections.some((c) => c.id === activeConnectionId)
                    if (!stillExists) {
                        const primary = connections.find((c) => c.isPrimary) ?? connections[0] ?? null
                        set({ activeConnectionId: primary?.id ?? null })
                    }
                } catch (err) {
                    // Legacy /connections endpoint may not exist — treat as empty list
                    set({ connections: [], isLoading: false, error: null })
                }
            },

            setActiveConnection: (id) => set({ activeConnectionId: id }),

            getPrimaryConnection: () => {
                return get().connections.find((c) => c.isPrimary) ?? null
            },

            getActiveConnection: () => {
                const { connections, activeConnectionId } = get()
                return connections.find((c) => c.id === activeConnectionId) ?? null
            },

            addConnection: (conn) =>
                set((state) => ({ connections: [...state.connections, conn] })),

            updateConnection: (conn) =>
                set((state) => ({
                    connections: state.connections.map((c) => (c.id === conn.id ? conn : c)),
                })),

            removeConnection: (id) =>
                set((state) => {
                    const next = state.connections.filter((c) => c.id !== id)
                    const activeConnectionId =
                        state.activeConnectionId === id
                            ? (next.find((c) => c.isPrimary) ?? next[0])?.id ?? null
                            : state.activeConnectionId
                    return { connections: next, activeConnectionId }
                }),
        }),
        {
            name: 'synodic-active-connection',
            // Only persist the active selection — connection list is always re-fetched
            partialize: (state) => ({ activeConnectionId: state.activeConnectionId }),
        }
    )
)
