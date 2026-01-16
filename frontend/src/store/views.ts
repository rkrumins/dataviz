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
  
  // Actions
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
    }),
    {
      name: 'nexus-views',
    }
  )
)

