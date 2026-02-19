/**
 * Workspaces store — manages registered workspaces and tracks the active one.
 *
 * A workspace binds a Provider + Graph Name + Blueprint into a queryable context.
 * Only `activeWorkspaceId` is persisted to localStorage so the user's last-selected
 * workspace is restored on reload. The workspace list is always fetched fresh.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'

interface WorkspacesState {
    workspaces: WorkspaceResponse[]
    activeWorkspaceId: string | null
    isLoading: boolean
    error: string | null

    // Actions
    loadWorkspaces: () => Promise<void>
    setActiveWorkspace: (id: string | null) => void
    getDefaultWorkspace: () => WorkspaceResponse | null
    getActiveWorkspace: () => WorkspaceResponse | null

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
            isLoading: false,
            error: null,

            loadWorkspaces: async () => {
                set({ isLoading: true, error: null })
                try {
                    const workspaces = await workspaceService.list()
                    set({ workspaces, isLoading: false })

                    // Auto-select: keep existing if still valid, otherwise use default
                    const { activeWorkspaceId } = get()
                    const stillExists = workspaces.some((w) => w.id === activeWorkspaceId)
                    if (!stillExists) {
                        const defaultWs = workspaces.find((w) => w.isDefault) ?? workspaces[0] ?? null
                        set({ activeWorkspaceId: defaultWs?.id ?? null })
                    }
                } catch (err) {
                    set({
                        isLoading: false,
                        error: err instanceof Error ? err.message : 'Failed to load workspaces',
                    })
                }
            },

            setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),

            getDefaultWorkspace: () => {
                return get().workspaces.find((w) => w.isDefault) ?? null
            },

            getActiveWorkspace: () => {
                const { workspaces, activeWorkspaceId } = get()
                return workspaces.find((w) => w.id === activeWorkspaceId) ?? null
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
                    const activeWorkspaceId =
                        state.activeWorkspaceId === id
                            ? (next.find((w) => w.isDefault) ?? next[0])?.id ?? null
                            : state.activeWorkspaceId
                    return { workspaces: next, activeWorkspaceId }
                }),
        }),
        {
            name: 'synodic-active-workspace',
            partialize: (state) => ({ activeWorkspaceId: state.activeWorkspaceId }),
        }
    )
)
