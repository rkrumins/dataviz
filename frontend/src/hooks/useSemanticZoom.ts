/**
 * useSemanticZoom - Ontology-driven auto-expand/collapse on zoom
 *
 * Replaces the deprecated useLevelOfDetail (hardcoded zoom thresholds,
 * polling-based) and useSpatialLoading (mock API, never wired).
 *
 * How it works:
 * - Reads `hierarchy.level` from each entity type in the schema
 * - Maps zoom ranges proportionally: zoomThreshold = 0.2 + (level * 0.25)
 * - Uses React Flow's onViewportChange (event-driven, NOT polling)
 * - Debounced 300ms to coalesce rapid zoom gestures
 * - Only processes nodes visible in the current viewport
 * - Zoom out: nodes above threshold → auto-collapse
 * - Zoom in: nodes at/below threshold → auto-expand + loadChildren
 * - Rate-limited: max 5 auto-expands per zoom gesture
 * - Manual overrides tracked until zoom crosses 2 threshold levels away
 *
 * NO hardcoded entity type strings — works with any ontology.
 * If entity types lack hierarchy.level, semantic zoom does nothing.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { Viewport, ReactFlowInstance } from '@xyflow/react'
import type { HierarchyNode } from '@/types/hierarchy'

// ============================================
// Types
// ============================================

export interface EntityTypeWithLevel {
  id: string
  hierarchy?: {
    level?: number
  }
}

export interface UseSemanticZoomOptions {
  /** React Flow instance for viewport queries */
  rfInstance: ReactFlowInstance | null
  /** Current expanded nodes */
  expandedNodes: Set<string>
  /** Setter for expanded nodes */
  setExpandedNodes: (fn: (prev: Set<string>) => Set<string>) => void
  /** Display map for node lookup */
  displayMap: Map<string, HierarchyNode>
  /** Parent map from containment hierarchy */
  parentMap: Map<string, string>
  /** Schema entity types with hierarchy levels */
  schemaEntityTypes: EntityTypeWithLevel[]
  /** Load children callback */
  loadChildren: (nodeId: string) => Promise<void>
  /** Enable/disable semantic zoom */
  enabled: boolean
}

export interface UseSemanticZoomResult {
  /** Connect this to ReactFlow's onViewportChange */
  onViewportChange: (viewport: Viewport) => void
  /** Register a manual override (user expanded/collapsed manually) */
  registerManualOverride: (nodeId: string) => void
  /** Current effective zoom level */
  currentZoom: number
  /** Whether semantic zoom is active */
  isEnabled: boolean
  /** Toggle semantic zoom on/off */
  toggle: () => void
}

// ============================================
// Constants
// ============================================

/** Base zoom for level 0 (top-level entities like domains) */
const BASE_ZOOM = 0.2

/** Zoom increment per hierarchy level */
const ZOOM_PER_LEVEL = 0.25

/** Debounce delay for viewport changes (ms) */
const DEBOUNCE_MS = 500

/** Max auto-expands per zoom gesture to prevent loading storms */
const MAX_AUTO_EXPANDS = 3

/** Minimum zoom delta to trigger processing (avoids micro-adjustments) */
const MIN_ZOOM_DELTA = 0.08

/**
 * Manual overrides are cleared when the zoom crosses this many threshold
 * levels away from the node's threshold (2 levels = 0.5 zoom units).
 */
const OVERRIDE_CLEAR_DISTANCE = ZOOM_PER_LEVEL * 2

// ============================================
// Hook
// ============================================

export function useSemanticZoom(options: UseSemanticZoomOptions): UseSemanticZoomResult {
  const {
    rfInstance,
    expandedNodes: _expandedNodes,
    setExpandedNodes,
    displayMap,
    parentMap: _parentMap,
    schemaEntityTypes,
    loadChildren,
    enabled,
  } = options

  const [isEnabled, setIsEnabled] = useState(enabled)
  const currentZoomRef = useRef(1)
  const manualOverridesRef = useRef(new Set<string>())
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLoadsRef = useRef(new Set<string>())

  // Build zoom threshold map from ontology: entityTypeId → zoom threshold
  // No hardcoded type names — purely derived from hierarchy.level
  const zoomThresholdByType = useMemo(() => {
    const map = new Map<string, number>()
    schemaEntityTypes.forEach((et) => {
      const level = et.hierarchy?.level
      if (level !== undefined) {
        map.set(et.id, BASE_ZOOM + level * ZOOM_PER_LEVEL)
      }
    })
    return map
  }, [schemaEntityTypes])

  // Get the zoom threshold for a node based on its entity type
  const getNodeZoomThreshold = useCallback(
    (node: HierarchyNode): number | null => {
      return zoomThresholdByType.get(node.typeId) ?? null
    },
    [zoomThresholdByType],
  )

  // Check whether a node is currently visible in the viewport
  const isNodeInViewport = useCallback(
    (nodeId: string): boolean => {
      if (!rfInstance) return false
      const rfNode = rfInstance.getNode(nodeId)
      if (!rfNode) return false

      const viewport = rfInstance.getViewport()
      const { x: vx, y: vy, zoom } = viewport

      // Viewport bounds in graph coordinates
      const viewWidth = (window.innerWidth || 1920) / zoom
      const viewHeight = (window.innerHeight || 1080) / zoom
      const viewLeft = -vx / zoom
      const viewTop = -vy / zoom

      const nx = rfNode.position.x
      const ny = rfNode.position.y
      const nw = rfNode.measured?.width ?? 200
      const nh = rfNode.measured?.height ?? 80

      return (
        nx + nw > viewLeft &&
        nx < viewLeft + viewWidth &&
        ny + nh > viewTop &&
        ny < viewTop + viewHeight
      )
    },
    [rfInstance],
  )

  // Core zoom-change processor
  const processZoomChange = useCallback(
    (zoom: number) => {
      if (!isEnabled || !rfInstance) return

      const prevZoom = currentZoomRef.current

      // Skip if zoom change is too small (avoids micro-adjustments from fitView/pan)
      const delta = Math.abs(zoom - prevZoom)
      if (delta < MIN_ZOOM_DELTA) return

      currentZoomRef.current = zoom

      // Determine zoom direction
      const zoomingIn = zoom > prevZoom
      const zoomingOut = zoom < prevZoom
      if (!zoomingIn && !zoomingOut) return

      let expandCount = 0

      setExpandedNodes((prev) => {
        const next = new Set(prev)

        displayMap.forEach((node, nodeId) => {
          // Handle manual overrides: skip unless zoom crossed far enough
          if (manualOverridesRef.current.has(nodeId)) {
            const threshold = getNodeZoomThreshold(node)
            if (threshold !== null && Math.abs(zoom - threshold) > OVERRIDE_CLEAR_DISTANCE) {
              manualOverridesRef.current.delete(nodeId)
            } else {
              return // Still overridden
            }
          }

          // Only process nodes visible in viewport
          if (!isNodeInViewport(nodeId)) return

          const threshold = getNodeZoomThreshold(node)
          if (threshold === null) return // No hierarchy level defined

          if (zoomingOut && zoom < threshold && next.has(nodeId)) {
            // Auto-collapse: entity type is too fine for current zoom
            next.delete(nodeId)
          }

          if (zoomingIn && zoom >= threshold && !next.has(nodeId)) {
            // Auto-expand: entity type is appropriate for current zoom
            const hasChildren =
              ((node.data?.childCount as number) > 0) ||
              (node.children && node.children.length > 0)

            if (hasChildren && expandCount < MAX_AUTO_EXPANDS) {
              next.add(nodeId)
              expandCount++

              // Trigger lazy load if not already pending
              if (!pendingLoadsRef.current.has(nodeId)) {
                pendingLoadsRef.current.add(nodeId)
                loadChildren(nodeId).finally(() => pendingLoadsRef.current.delete(nodeId))
              }
            }
          }
        })

        return next
      })
    },
    [isEnabled, rfInstance, displayMap, setExpandedNodes, getNodeZoomThreshold, isNodeInViewport, loadChildren],
  )

  // Debounced viewport change handler — connect to ReactFlow's onViewportChange
  const onViewportChange = useCallback(
    (viewport: Viewport) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = setTimeout(() => {
        processZoomChange(viewport.zoom)
      }, DEBOUNCE_MS)
    },
    [processZoomChange],
  )

  const toggle = useCallback(() => setIsEnabled((prev) => !prev), [])

  // Register a manual override — prevents semantic zoom from undoing user actions
  const registerManualOverride = useCallback((nodeId: string) => {
    manualOverridesRef.current.add(nodeId)
  }, [])

  return {
    onViewportChange,
    registerManualOverride,
    currentZoom: currentZoomRef.current,
    isEnabled,
    toggle,
  }
}
