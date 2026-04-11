/**
 * Workspaces store — manages registered workspaces and tracks the active one.
 *
 * A workspace is an operational context containing one or more data sources.
 * Both `activeWorkspaceId` and `activeDataSourceId` are persisted to localStorage
 * so the user's last selection is restored on reload. The workspace list is always
 * fetched fresh.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { workspaceService, type WorkspaceResponse, type DataSourceResponse } from '@/services/workspaceService'
import { useSchemaStore } from '@/store/schema'
import { cleanupOnWorkspaceSwitch } from '@/store/workspaceSwitchCleanup'

interface WorkspacesState {
    workspaces: WorkspaceResponse[]
    activeWorkspaceId: string | null
    activeDataSourceId: string | null
    isLoading: boolean
    error: string | null

    // Actions
    loadWorkspaces: () => Promise<void>
    setActiveWorkspace: (id: string | null) => void
    setActiveDataSource: (id: string | null) => void
    getDefaultWorkspace: () => WorkspaceResponse | null
    getActiveWorkspace: () => WorkspaceResponse | null
    getActiveDataSource: () => DataSourceResponse | null

    // Mutation helpers (called after CRUD from WorkspacePanel)
    addWorkspace: (ws: WorkspaceResponse) => void
    updateWorkspace: (ws: WorkspaceResponse) => void
    removeWorkspace: (id: string) => void
}

export const useWorkspacesStore = create<WorkspacesState>()(
    persist(
        (set, get) => ({
            workspaces: [],
            activeWorkspaceId: null,
            activeDataSourceId: null,
            isLoading: false,
            error: null,

            loadWorkspaces: async () => {
                set({ isLoading: true, error: null })
                try {
                    const workspaces = await workspaceService.list()
                    set({ workspaces, isLoading: false })

                    // Auto-select: keep existing if still valid, otherwise use default
                    const { activeWorkspaceId, activeDataSourceId } = get()
                    const stillExists = workspaces.some((w) => w.id === activeWorkspaceId)
                    if (!stillExists) {
                        const defaultWs = workspaces.find((w) => w.isDefault) ?? workspaces[0] ?? null
                        const primaryDs = defaultWs?.dataSources?.find((ds) => ds.isPrimary)
                            ?? defaultWs?.dataSources?.[0] ?? null
                        set({
                            activeWorkspaceId: defaultWs?.id ?? null,
                            activeDataSourceId: primaryDs?.id ?? null,
                        })
                        useSchemaStore.getState().setActiveScopeKey(defaultWs?.id ?? null, primaryDs?.id ?? null)
                    } else if (activeDataSourceId) {
                        // Verify active data source still exists in active workspace
                        const ws = workspaces.find((w) => w.id === activeWorkspaceId)
                        const dsExists = ws?.dataSources?.some((ds) => ds.id === activeDataSourceId)
                        if (!dsExists) {
                            const primaryDs = ws?.dataSources?.find((ds) => ds.isPrimary)
                                ?? ws?.dataSources?.[0] ?? null
                            set({ activeDataSourceId: primaryDs?.id ?? null })
                            useSchemaStore.getState().setActiveScopeKey(activeWorkspaceId, primaryDs?.id ?? null)
                        } else {
                            // Scope already valid — still sync in case of cold start
                            useSchemaStore.getState().setActiveScopeKey(activeWorkspaceId, activeDataSourceId)
                        }
                    }
                } catch (err) {
                    set({
                        isLoading: false,
                        error: err instanceof Error ? err.message : 'Failed to load workspaces',
                    })
                }
            },

            setActiveWorkspace: (id) => {
                const ws = id ? get().workspaces.find((w) => w.id === id) : null
                const primaryDs = ws?.dataSources?.find((ds) => ds.isPrimary)
                    ?? ws?.dataSources?.[0] ?? null
                const nextDsId = primaryDs?.id ?? null
                const prev = get()
                const scopeChanged =
                    prev.activeWorkspaceId !== id ||
                    prev.activeDataSourceId !== nextDsId

                // Cleanup BEFORE the state transition so the next render of
                // any <SchemaScope> sees an empty cache and triggers a cold
                // fetch for the new scope. Skip when nothing is actually
                // changing — no-op setters must not purge caches.
                if (scopeChanged) {
                    cleanupOnWorkspaceSwitch()
                }

                set({
                    activeWorkspaceId: id,
                    activeDataSourceId: nextDsId,
                })
                useSchemaStore.getState().setActiveScopeKey(id, nextDsId)
            },

            setActiveDataSource: (id) => {
                const prev = get()
                const scopeChanged = prev.activeDataSourceId !== id

                if (scopeChanged) {
                    cleanupOnWorkspaceSwitch()
                }

                set({ activeDataSourceId: id })
                const wsId = get().activeWorkspaceId
                useSchemaStore.getState().setActiveScopeKey(wsId, id)
            },

            getDefaultWorkspace: () => {
                return get().workspaces.find((w) => w.isDefault) ?? null
            },

            getActiveWorkspace: () => {
                const { workspaces, activeWorkspaceId } = get()
                return workspaces.find((w) => w.id === activeWorkspaceId) ?? null
            },

            getActiveDataSource: () => {
                const ws = get().getActiveWorkspace()
                if (!ws) return null
                const { activeDataSourceId } = get()
                if (activeDataSourceId) {
                    return ws.dataSources?.find((ds) => ds.id === activeDataSourceId) ?? null
                }
                return ws.dataSources?.find((ds) => ds.isPrimary)
                    ?? ws.dataSources?.[0] ?? null
            },

            addWorkspace: (ws) =>
                set((state) => ({ workspaces: [...state.workspaces, ws] })),

            updateWorkspace: (ws) =>
                set((state) => ({
                    workspaces: state.workspaces.map((w) => (w.id === ws.id ? ws : w)),
                })),

            removeWorkspace: (id) =>
                set((state) => {
                    const next = state.workspaces.filter((w) => w.id !== id)
                    let activeWorkspaceId = state.activeWorkspaceId
                    let activeDataSourceId = state.activeDataSourceId
                    if (state.activeWorkspaceId === id) {
                        const fallback = next.find((w) => w.isDefault) ?? next[0]
                        activeWorkspaceId = fallback?.id ?? null
                        activeDataSourceId = fallback?.dataSources?.find((ds) => ds.isPrimary)?.id
                            ?? fallback?.dataSources?.[0]?.id ?? null
                    }
                    return { workspaces: next, activeWorkspaceId, activeDataSourceId }
                }),
        }),
        {
            name: 'synodic-active-workspace',
            partialize: (state) => ({
                activeWorkspaceId: state.activeWorkspaceId,
                activeDataSourceId: state.activeDataSourceId,
            }),
        }
    )
)
