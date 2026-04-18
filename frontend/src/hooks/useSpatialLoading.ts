/**
 * @deprecated Uses mock API and is never wired to React Flow. Replaced by
 * viewport-aware filtering in GraphCanvas (MAX_VISIBLE_NODES cap + viewport bounds).
 */
import { useCallback, useRef, useState } from 'react'
import type { Viewport } from '@xyflow/react'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { debounce } from '@/lib/utils'

interface ViewportBounds {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  zoom: number
}

interface SpatialLoadingResult {
  onViewportChange: (event: { viewState: Viewport }) => void
  isLoadingRegion: boolean
  loadedRegions: Set<string>
}

/**
 * useSpatialLoading - Hook for viewport-based lazy loading
 * 
 * Features:
 * - Debounced viewport change detection
 * - Region-based caching to avoid duplicate loads
 * - Automatic LOD adjustment based on zoom level
 * - Background prefetching of adjacent regions
 */
export function useSpatialLoading(): SpatialLoadingResult {
  const [isLoadingRegion, setIsLoadingRegion] = useState(false)
  const loadedRegionsRef = useRef<Set<string>>(new Set())

  const {
    setViewport,
    addNodes,
    addEdges,
    activeLensId,
    cacheRegion,
    getCachedRegion,
  } = useCanvasStore()

  const { lodDefault: _lodDefault } = usePersonaStore()

  /**
   * Calculate which region the viewport covers (grid-based)
   */
  const getRegionKey = useCallback((bounds: ViewportBounds): string => {
    const gridSize = 1000 // Virtual grid cell size
    const xRegion = Math.floor(bounds.xMin / gridSize)
    const yRegion = Math.floor(bounds.yMin / gridSize)
    const zoomLevel = Math.floor(bounds.zoom * 10) / 10
    return `${xRegion}:${yRegion}:${zoomLevel}`
  }, [])

  /**
   * Determine LOD level based on zoom.
   * NOTE: These LOD level names ('domain', 'app', 'asset') are fallback heuristics.
   * Ideally these should be derived from schema entity type hierarchy levels,
   * mapping zoom ranges to the schema's hierarchy.level values dynamically.
   */
  const getLODFromZoom = useCallback((zoom: number): 'domain' | 'app' | 'asset' => {
    if (zoom < 0.3) return 'domain'
    if (zoom < 0.8) return 'app'
    return 'asset'
  }, [])

  /**
   * Fetch nodes for a viewport region
   */
  const fetchRegion = useCallback(async (bounds: ViewportBounds) => {
    if (!activeLensId) return

    const regionKey = getRegionKey(bounds)

    // Check cache first
    const cached = getCachedRegion(regionKey)
    if (cached) {
      addNodes(cached)
      return
    }

    // Check if already loaded
    if (loadedRegionsRef.current.has(regionKey)) {
      return
    }

    setIsLoadingRegion(true)
    loadedRegionsRef.current.add(regionKey)

    try {
      const lod = getLODFromZoom(bounds.zoom)

      // TODO: Replace with actual API call
      const response = await mockFetchLineage({
        lensId: activeLensId,
        viewport: bounds,
        lodLevel: lod,
      })

      // Cache and add nodes
      cacheRegion(regionKey, response.nodes)
      addNodes(response.nodes)
      addEdges(response.edges)
    } catch (error) {
      console.error('Failed to load region:', error)
      // Remove from loaded so retry is possible
      loadedRegionsRef.current.delete(regionKey)
    } finally {
      setIsLoadingRegion(false)
    }
  }, [
    activeLensId,
    getRegionKey,
    getLODFromZoom,
    getCachedRegion,
    cacheRegion,
    addNodes,
    addEdges
  ])

  /**
   * Debounced viewport change handler
   */
  const debouncedFetch = useCallback(
    debounce((viewport: Viewport) => {
      // Calculate viewport bounds in graph coordinates
      // This is a simplified calculation - in production you'd account for
      // the actual viewport dimensions
      const bounds: ViewportBounds = {
        xMin: -viewport.x / viewport.zoom,
        xMax: (-viewport.x + 1920) / viewport.zoom, // Assuming 1920px width
        yMin: -viewport.y / viewport.zoom,
        yMax: (-viewport.y + 1080) / viewport.zoom, // Assuming 1080px height
        zoom: viewport.zoom,
      }

      fetchRegion(bounds)
    }, 150),
    [fetchRegion]
  )

  /**
   * Handle viewport changes from React Flow
   * Safely handles various event formats from different React Flow versions
   */
  const onViewportChange = useCallback(
    (event?: unknown, viewport?: Viewport) => {
      // Handle different callback signatures
      let vp: Viewport | undefined = viewport

      // React Flow v12+ passes viewport directly as second arg
      if (viewport && typeof viewport === 'object' && 'x' in viewport) {
        vp = viewport
      }
      // Older format with viewState
      else if (event && typeof event === 'object' && 'viewState' in event) {
        vp = (event as { viewState: Viewport }).viewState
      }
      // Direct viewport object
      else if (event && typeof event === 'object' && 'x' in event && 'y' in event && 'zoom' in event) {
        vp = event as Viewport
      }

      if (!vp) return

      setViewport(vp)
      debouncedFetch(vp)
    },
    [setViewport, debouncedFetch]
  )

  return {
    onViewportChange,
    isLoadingRegion,
    loadedRegions: loadedRegionsRef.current,
  }
}

/**
 * Mock API call - Replace with actual backend integration
 */
async function mockFetchLineage(_params: {
  lensId: string
  viewport: ViewportBounds
  lodLevel: 'domain' | 'app' | 'asset'
}): Promise<{
  nodes: ReturnType<typeof useCanvasStore.getState>['nodes']
  edges: ReturnType<typeof useCanvasStore.getState>['edges']
}> {
  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 300))

  // Return empty for now - will be populated by actual API
  return {
    nodes: [],
    edges: [],
  }
}

/**
 * Hook to prefetch adjacent regions for smoother panning
 */
export function usePrefetchAdjacentRegions() {
  // TODO: Implement prefetching logic
  // This would fetch regions adjacent to the current viewport
  // when the user is idle, to reduce loading during panning
}

