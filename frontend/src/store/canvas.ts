import { create } from 'zustand'
import type { Node, Edge, Viewport } from '@xyflow/react'

export interface LineageNode extends Node {
  data: {
    label: string
    businessLabel?: string
    technicalLabel?: string
    urn: string
    type: string // Allow any entity type
    lensId?: string
    classifications?: string[]
    confidence?: number
    metadata?: Record<string, unknown>
    // Hierarchy
    childIds?: string[]
    parentId?: string
    isExpanded?: boolean
    // Roll-up data
    _collapsedChildCount?: number
    _rollupData?: Record<string, unknown>
  }
}

export interface LineageEdge extends Edge {
  data?: {
    confidence?: number
    edgeType?: string
    relationship?: string
    animated?: boolean
    label?: string
    // For aggregated edges
    isAggregated?: boolean
    sourceEdgeCount?: number
    sourceEdges?: string[]
  }
}

interface CanvasState {
  // Nodes and Edges
  nodes: LineageNode[]
  edges: LineageEdge[]
  setNodes: (nodes: LineageNode[]) => void
  setEdges: (edges: LineageEdge[]) => void
  addNodes: (nodes: LineageNode[]) => void
  addEdges: (edges: LineageEdge[]) => void

  // Selection
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  selectNode: (id: string, multi?: boolean) => void
  selectEdge: (id: string, multi?: boolean) => void
  clearSelection: () => void

  // Viewport
  viewport: Viewport
  setViewport: (viewport: Viewport) => void

  // Loading State
  isLoading: boolean
  loadingRegions: Set<string>
  setLoading: (loading: boolean) => void
  addLoadingRegion: (region: string) => void
  removeLoadingRegion: (region: string) => void

  // Active Lens
  activeLensId: string | null
  setActiveLens: (lensId: string | null) => void

  // Trace State
  traceOrigin: string | null
  traceDirection: 'upstream' | 'downstream' | 'both'
  traceDepth: number
  setTraceOrigin: (nodeId: string | null) => void
  setTraceDirection: (direction: 'upstream' | 'downstream' | 'both') => void
  setTraceDepth: (depth: number) => void

  // Cache
  cachedRegions: Map<string, LineageNode[]>
  cacheRegion: (key: string, nodes: LineageNode[]) => void
  getCachedRegion: (key: string) => LineageNode[] | undefined
  clearCache: () => void

  // Editing Mode
  isEditing: boolean
  setEditing: (isEditing: boolean) => void

  // Node/Edge CRUD (Manual)
  updateNode: (id: string, data: Partial<LineageNode['data']>) => void
  removeNode: (id: string) => void
  removeEdge: (id: string) => void
}

import { persist, createJSONStorage } from 'zustand/middleware'

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      // Nodes and Edges
      nodes: [],
      edges: [],
      setNodes: (nodes) => set({ nodes }),
      setEdges: (edges) => set({ edges }),
      addNodes: (newNodes) => set((state) => {
        const existingIds = new Set(state.nodes.map((n) => n.id))
        const uniqueNodes = newNodes.filter((n) => !existingIds.has(n.id))
        return { nodes: [...state.nodes, ...uniqueNodes] }
      }),
      addEdges: (newEdges) => set((state) => {
        const existingIds = new Set(state.edges.map((e) => e.id))
        const uniqueEdges = newEdges.filter((e) => !existingIds.has(e.id))
        return { edges: [...state.edges, ...uniqueEdges] }
      }),

      // Selection
      selectedNodeIds: [],
      selectedEdgeIds: [],
      selectNode: (id, multi = false) => set((state) => ({
        selectedNodeIds: multi
          ? state.selectedNodeIds.includes(id)
            ? state.selectedNodeIds.filter((nid) => nid !== id)
            : [...state.selectedNodeIds, id]
          : [id],
        selectedEdgeIds: multi ? state.selectedEdgeIds : [],
      })),
      selectEdge: (id, multi = false) => set((state) => ({
        selectedEdgeIds: multi
          ? state.selectedEdgeIds.includes(id)
            ? state.selectedEdgeIds.filter((eid) => eid !== id)
            : [...state.selectedEdgeIds, id]
          : [id],
        selectedNodeIds: multi ? state.selectedNodeIds : [],
      })),
      clearSelection: () => set({ selectedNodeIds: [], selectedEdgeIds: [] }),

      // Viewport
      viewport: { x: 0, y: 0, zoom: 1 },
      setViewport: (viewport) => set({ viewport }),

      // Loading
      isLoading: false,
      loadingRegions: new Set(),
      setLoading: (isLoading) => set({ isLoading }),
      addLoadingRegion: (region) => set((state) => {
        const newRegions = new Set(state.loadingRegions)
        newRegions.add(region)
        return { loadingRegions: newRegions, isLoading: true }
      }),
      removeLoadingRegion: (region) => set((state) => {
        const newRegions = new Set(state.loadingRegions)
        newRegions.delete(region)
        return {
          loadingRegions: newRegions,
          isLoading: newRegions.size > 0
        }
      }),

      // Active Lens
      activeLensId: null,
      setActiveLens: (activeLensId) => set({ activeLensId }),

      // Trace
      traceOrigin: null,
      traceDirection: 'both',
      traceDepth: 10,
      setTraceOrigin: (traceOrigin) => set({ traceOrigin }),
      setTraceDirection: (traceDirection) => set({ traceDirection }),
      setTraceDepth: (traceDepth) => set({ traceDepth }),

      // Cache
      cachedRegions: new Map(),
      cacheRegion: (key, nodes) => set((state) => {
        const newCache = new Map(state.cachedRegions)
        newCache.set(key, nodes)
        return { cachedRegions: newCache }
      }),
      getCachedRegion: (key) => get().cachedRegions.get(key),
      clearCache: () => set({ cachedRegions: new Map() }),

      // Editing Mode
      isEditing: false,
      setEditing: (isEditing) => set({ isEditing }),

      // Node/Edge CRUD (Manual)
      updateNode: (id, data) => set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, ...data } } : n
        )
      })),
      removeNode: (id) => set((state) => ({
        nodes: state.nodes.filter((n) => n.id !== id),
        edges: state.edges.filter((e) => e.source !== id && e.target !== id)
      })),
      removeEdge: (id) => set((state) => ({
        edges: state.edges.filter((e) => e.id !== id)
      })),
    }),
    {
      name: 'canvas-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        nodes: state.nodes,
        edges: state.edges,
        viewport: state.viewport,
        activeLensId: state.activeLensId
      }),
    }
  )
)

// Selector hooks
export const useNodes = () => useCanvasStore((s) => s.nodes)
export const useEdges = () => useCanvasStore((s) => s.edges)
export const useSelectedNodes = () => useCanvasStore((s) => s.selectedNodeIds)
export const useIsLoading = () => useCanvasStore((s) => s.isLoading)

