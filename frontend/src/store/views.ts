import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Viewport } from '@xyflow/react'
import type { PersonaMode, LODLevel } from './persona'
import { generateId } from '@/lib/utils'

export interface SavedView {
  id: string
  name: string
  description?: string
  lensId: string
  viewport: Viewport
  filters: {
    nodeTypes: string[]
    classifications: string[]
    searchQuery: string
  }
  persona: PersonaMode
  lod: LODLevel
  traceOrigin?: string
  createdAt: string
  updatedAt: string
  isPinned: boolean
}

interface ViewsState {
  views: SavedView[]
  recentViewIds: string[]

  // Local actions
  saveView: (view: Omit<SavedView, 'id' | 'createdAt' | 'updatedAt'>) => string
  updateView: (id: string, updates: Partial<SavedView>) => void
  deleteView: (id: string) => void
  duplicateView: (id: string) => string

  // Pinning
  togglePin: (id: string) => void
  getPinnedViews: () => SavedView[]

  // Recent
  addToRecent: (id: string) => void
  getRecentViews: (limit?: number) => SavedView[]

  // Search
  searchViews: (query: string) => SavedView[]

  // Backend sync (optimistic — local state updated first, then synced async)
  // contextId can be a workspace ID (ws_xxx) or legacy connection ID
  syncToBackend: (contextId: string) => Promise<void>
  loadFromBackend: (contextId: string) => Promise<void>
  deleteFromBackend: (id: string, contextId: string) => Promise<void>
}

export const useViewsStore = create<ViewsState>()(
  persist(
    (set, get) => ({
      views: [],
      recentViewIds: [],
      
      saveView: (viewData) => {
        const id = generateId('view')
        const now = new Date().toISOString()
        const view: SavedView = {
          ...viewData,
          id,
          createdAt: now,
          updatedAt: now,
        }
        set((state) => ({
          views: [...state.views, view],
          recentViewIds: [id, ...state.recentViewIds.slice(0, 9)],
        }))
        return id
      },
      
      updateView: (id, updates) => set((state) => ({
        views: state.views.map((v) =>
          v.id === id
            ? { ...v, ...updates, updatedAt: new Date().toISOString() }
            : v
        ),
      })),
      
      deleteView: (id) => set((state) => ({
        views: state.views.filter((v) => v.id !== id),
        recentViewIds: state.recentViewIds.filter((vid) => vid !== id),
      })),
      
      duplicateView: (id) => {
        const original = get().views.find((v) => v.id === id)
        if (!original) return ''
        
        const newId = generateId('view')
        const now = new Date().toISOString()
        const duplicate: SavedView = {
          ...original,
          id: newId,
          name: `${original.name} (Copy)`,
          createdAt: now,
          updatedAt: now,
          isPinned: false,
        }
        set((state) => ({ views: [...state.views, duplicate] }))
        return newId
      },
      
      togglePin: (id) => set((state) => ({
        views: state.views.map((v) =>
          v.id === id ? { ...v, isPinned: !v.isPinned } : v
        ),
      })),
      
      getPinnedViews: () => get().views.filter((v) => v.isPinned),
      
      addToRecent: (id) => set((state) => ({
        recentViewIds: [
          id,
          ...state.recentViewIds.filter((vid) => vid !== id).slice(0, 9),
        ],
      })),
      
      getRecentViews: (limit = 5) => {
        const { views, recentViewIds } = get()
        return recentViewIds
          .slice(0, limit)
          .map((id) => views.find((v) => v.id === id))
          .filter((v): v is SavedView => v !== undefined)
      },
      
      searchViews: (query) => {
        const lowerQuery = query.toLowerCase()
        return get().views.filter(
          (v) =>
            v.name.toLowerCase().includes(lowerQuery) ||
            v.description?.toLowerCase().includes(lowerQuery) ||
            v.lensId.toLowerCase().includes(lowerQuery)
        )
      },

      // ── Backend sync ───────────────────────────────────────────────
      syncToBackend: async (contextId) => {
        const views = get().views
        const API = contextId.startsWith('ws_')
          ? `/api/v1/v1/${contextId}/assets/views`
          : `/api/v1/connections/${contextId}/views`
        for (const view of views) {
          try {
            await fetch(API, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: view.name,
                description: view.description,
                viewType: 'canvas',
                config: {
                  viewport: view.viewport,
                  filters: view.filters,
                  persona: view.persona,
                  lod: view.lod,
                  traceOrigin: view.traceOrigin,
                  lensId: view.lensId,
                  isPinned: view.isPinned,
                },
              }),
            })
          } catch {
            // Swallow per-view errors — best-effort sync
          }
        }
      },

      loadFromBackend: async (contextId) => {
        try {
          const API = contextId.startsWith('ws_')
            ? `/api/v1/v1/${contextId}/assets/views`
            : `/api/v1/connections/${contextId}/views`
          const res = await fetch(API)
          if (!res.ok) return
          const remote: Array<{
            id: string
            name: string
            description?: string
            config: Record<string, unknown>
            createdAt: string
            updatedAt: string
          }> = await res.json()

          // Merge: backend wins on conflicts (matching by name), new remote views added
          set((state) => {
            const localMap = new Map(state.views.map((v) => [v.name, v]))
            const merged = [...state.views]
            for (const r of remote) {
              if (!localMap.has(r.name)) {
                const cfg = (r.config ?? {}) as Record<string, unknown>
                merged.push({
                  id: r.id,
                  name: r.name,
                  description: r.description,
                  lensId: (cfg.lensId as string) ?? '',
                  viewport: (cfg.viewport as Viewport) ?? { x: 0, y: 0, zoom: 1 },
                  filters: (cfg.filters as SavedView['filters']) ?? {
                    nodeTypes: [],
                    classifications: [],
                    searchQuery: '',
                  },
                  persona: (cfg.persona as PersonaMode) ?? 'explorer',
                  lod: (cfg.lod as LODLevel) ?? 'normal',
                  traceOrigin: cfg.traceOrigin as string | undefined,
                  createdAt: r.createdAt,
                  updatedAt: r.updatedAt,
                  isPinned: (cfg.isPinned as boolean) ?? false,
                })
              }
            }
            return { views: merged }
          })
        } catch {
          // Swallow — localStorage remains the source of truth when offline
        }
      },

      deleteFromBackend: async (id, contextId) => {
        try {
          const API = contextId.startsWith('ws_')
            ? `/api/v1/v1/${contextId}/assets/views/${id}`
            : `/api/v1/connections/${contextId}/views/${id}`
          await fetch(API, {
            method: 'DELETE',
          })
        } catch {
          // Best-effort
        }
      },
    }),
    {
      name: 'nexus-views',
    }
  )
)

