import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { ComputedEdge } from './types'

// Global visibility tracker for extreme performance on 10k+ nodes
const globalVisibleNodes = new Set<string>()
let globalNodeObserver: IntersectionObserver | null = null

function getSharedNodeObserver(triggerRedraw: () => void) {
  if (typeof window === 'undefined') return null
  if (!globalNodeObserver) {
    globalNodeObserver = new IntersectionObserver((entries) => {
      let changed = false
      entries.forEach(entry => {
        const id = entry.target.id
        if (!id) return
        if (entry.isIntersecting) {
          if (!globalVisibleNodes.has(id)) {
            globalVisibleNodes.add(id)
            changed = true
          }
        } else {
          if (globalVisibleNodes.has(id)) {
            globalVisibleNodes.delete(id)
            changed = true
          }
        }
      })
      if (changed) {
        // Schedule redraw if visibility changes
        triggerRedraw()
      }
    }, {
      root: null, // observe relative to viewport
      rootMargin: '100px', // start rendering slightly before it enters screen
      threshold: 0
    })
  }
  return globalNodeObserver
}

export function LineageFlowOverlay({
  nodes,
  edges,
  expandedNodes,
  selectEdge,
  isEdgePanelOpen,
  toggleEdgePanel,
  triggerRedrawRef,
  isTracing = false,
  traceResult = null,
  highlightedEdges,
  isHighlightActive = false,
  resolveEdgeColor,
}: {
  nodes: any[],
  edges: any[],
  expandedNodes: Set<string>,
  selectEdge: (id: string) => void,
  isEdgePanelOpen: boolean,
  toggleEdgePanel: () => void,
  triggerRedrawRef?: React.MutableRefObject<(() => void) | null>
  isTracing?: boolean,
  traceResult?: any | null,
  highlightedEdges?: Set<string>,
  isHighlightActive?: boolean,
  resolveEdgeColor?: (edgeType: string) => string,
}) {
  // Store computed abstract edges instead of direct React nodes for virtualization
  const [computedEdges, setComputedEdges] = useState<ComputedEdge[]>([])

  // Viewport tracking for virtualization
  const [viewport, setViewport] = useState({ scrollTop: 0, clientHeight: typeof window !== 'undefined' ? window.innerHeight : 1000 })
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const updateFlowRef = useRef<(() => void) | null>(null)
  const rafIdRef = useRef<number | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)

  // Serialize expandedNodes Set to array for proper React dependency tracking
  const expandedNodesArray = useMemo(() => {
    return Array.from(expandedNodes).sort().join(',')
  }, [expandedNodes])

  // Debounced update function using requestAnimationFrame
  const scheduleUpdate = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      if (updateFlowRef.current) {
        updateFlowRef.current()
      }
    })
  }, [])

  // Update paths function with optimizations
  const updateFlow = useCallback(() => {
    if (!containerRef.current) return

    const containerRect = containerRef.current.getBoundingClientRect()
    // Find scroll parent once
    if (!scrollParentRef.current) {
      scrollParentRef.current = containerRef.current.closest('.overflow-y-auto') as HTMLElement
      if (scrollParentRef.current) {
        setViewport({
          scrollTop: scrollParentRef.current.scrollTop,
          clientHeight: scrollParentRef.current.clientHeight
        })
      } else {
        setViewport({
          scrollTop: 0,
          clientHeight: containerRect.height || window.innerHeight
        })
      }
    }

    const newComputedEdges: ComputedEdge[] = []

    // Batch DOM reads by collecting all elements first
    const elementCache = new Map<string, HTMLElement>()

    // ONLY compute paths for edges where BOTH nodes are strictly visible on screen!
    // This fully prevents the tornado of 10,000 edges pointing to clipped items, unlocking ultra fast 60fps scrolling.
    const activeEdges = edges.filter(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`

      return globalVisibleNodes.has(sourceId) && globalVisibleNodes.has(targetId)
    })

    activeEdges.forEach(edge => {
      const sourceId = `layer-node-${edge.source}`
      const targetId = `layer-node-${edge.target}`

      // Cache element lookups
      let sourceEl: HTMLElement | null = elementCache.get(sourceId) || null
      if (!sourceEl) {
        sourceEl = document.getElementById(sourceId)
        if (sourceEl) elementCache.set(sourceId, sourceEl)
      }

      let targetEl: HTMLElement | null = elementCache.get(targetId) || null
      if (!targetEl) {
        targetEl = document.getElementById(targetId)
        if (targetEl) elementCache.set(targetId, targetEl)
      }

      if (sourceEl && targetEl) {
        const sRect = sourceEl.getBoundingClientRect()
        const tRect = targetEl.getBoundingClientRect()

        // Relative coordinates
        // Offset sx/tx slightly from the card boundary to make arrowheads/terminals visible
        const sx = sRect.right - containerRect.left + 2
        const sy = sRect.top + sRect.height / 2 - containerRect.top

        // Target: point slightly before the card boundary
        let tx = tRect.left - containerRect.left - 4
        const ty = tRect.top + tRect.height / 2 - containerRect.top

        // We no longer cull here based on window.innerHeight, because the container itself scrolls.
        // Instead, we calculate local bounding Y coordinates and cull in the render loop (Virtualization).
        // `sy` and `ty` are relative to the top of the canvas container.
        const minY = Math.min(sy, ty)
        const maxY = Math.max(sy, ty)

        // Smart Routing Logic
        let pathD = ''
        const isSameColumn = Math.abs(sRect.left - tRect.left) < 50
        const isSelf = edge.source === edge.target

        // Multi-edge offsetting
        // If there are multiple edges (groupTotal > 1), we offset the control points vertically
        // or curve magnitude to separate them.
        const index = edge.groupIndex || 0

        if (isSameColumn && !isSelf) {
          // "Bracket" routing: Right -> Right (Cleaner layout)
          // Use a tighter loop for same-column edges
          tx = tRect.right - containerRect.left

          const curveDist = 30 + (index * 8)
          const cp1x = sx + curveDist
          const cp2x = tx + curveDist

          // Keep Y aligned with source/target for straight horizontal exit/entry
          const cp1y = sy
          const cp2y = ty

          pathD = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`
        } else {
          // Standard Left-to-Right S-Curve (Sigmoid)
          // This creates a beautiful, simple flow without "ballooning"
          const dist = Math.abs(tx - sx)

          // Fixed curvature creates a uniform look. 0.5 = standard S-curve.
          const curvature = 0.5

          const cp1x = sx + dist * curvature
          const cp2x = tx - dist * curvature

          // CRITICAL: Keep control point Ys aligned with Source/Target Ys
          // This ensures the line leaves horizontally and enters horizontally.
          // We apply vOffset ONLY to the middle if we wanted separation,
          // but for "prettiness", pure S-curves usually look best.
          // If we really need separation for multi-edges, we can adjust the CP x-values slightly
          // or just let them overlap cleanly as "highways".
          const cp1y = sy
          const cp2y = ty

          pathD = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`
        }

        // Theme color priority
        const primaryType = edge.types && edge.types.length > 0 ? edge.types[0] : (edge.originalType || '')
        const typeColor = resolveEdgeColor
          ? resolveEdgeColor(primaryType)
          : '#3b82f6'

        let color = typeColor
        // Base opacity varies by confidence (if available) - increased base for vibrancy
        let edgeOpacity = 0.5 + (edge.confidence || 0.4) * 0.5

        // Base stroke width depends on bundling!
        let baseStrokeWidth = 1.5
        if (edge.isBundled) {
          // Logarithmic scaling for bundle volume
          baseStrokeWidth = Math.min(2 + Math.log2(edge.edgeCount) * 1.5, 10)
        } else if (edge.isAggregated) {
          baseStrokeWidth = 2.5
        }

        let dynamicStrokeWidth = baseStrokeWidth

        // Determine if this edge is highlighted (click-to-highlight)
        const isEdgeHighlighted = isHighlightActive && highlightedEdges?.has(edge.id)
        const isEdgeDimmed = isHighlightActive && !highlightedEdges?.has(edge.id)

        if (isTracing && traceResult) {
          // TRACE MODE
          edgeOpacity = edge.isGhost ? 0.4 : 0.8
          dynamicStrokeWidth = baseStrokeWidth + 1
          const srcInUpstream = traceResult.upstreamNodes?.has(edge.source)
          const tgtInUpstream = traceResult.upstreamNodes?.has(edge.target)
          const srcInDownstream = traceResult.downstreamNodes?.has(edge.source)
          const tgtInDownstream = traceResult.downstreamNodes?.has(edge.target)

          if (srcInUpstream || tgtInUpstream) {
            color = '#06b6d4' // cyan
          } else if (srcInDownstream || tgtInDownstream) {
            color = '#f59e0b' // amber
          } else if (!edge.isGhost) {
            color = '#a78bfa' // purple
          }

          if (!srcInUpstream && !tgtInUpstream && !srcInDownstream && !tgtInDownstream) {
            edgeOpacity = edge.isGhost ? 0.05 : 0.1
            dynamicStrokeWidth = Math.max(1, baseStrokeWidth - 1)
          }
        } else {
          // Normal/highlight mode
          if (isEdgeHighlighted) {
            edgeOpacity = 0.9
            dynamicStrokeWidth = baseStrokeWidth + 1
          } else if (isEdgeDimmed) {
            edgeOpacity = edge.isGhost ? 0.05 : 0.1
            dynamicStrokeWidth = Math.max(1, baseStrokeWidth - 1)
          }
        }

        // Ghost styling for abstracted/bundled edges
        if (edge.isGhost) {
          edgeOpacity = Math.min(0.7, edgeOpacity)
        }

        newComputedEdges.push({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          minY,
          maxY,
          pathD,
          color,
          dynamicStrokeWidth,
          edgeOpacity,
          isGhost: edge.isGhost || false,
          isBundled: edge.isBundled || false,
          edgeCount: edge.edgeCount || 0,
          sx, sy, tx, ty
        })
      }
    })
    setComputedEdges(newComputedEdges)
  }, [edges, selectEdge, isEdgePanelOpen, toggleEdgePanel, isTracing, traceResult, highlightedEdges, isHighlightActive, resolveEdgeColor, hoveredEdgeId])

  // Store updateFlow in ref for ResizeObserver access and expose to parent
  useEffect(() => {
    updateFlowRef.current = updateFlow
    if (triggerRedrawRef) {
      triggerRedrawRef.current = scheduleUpdate
    }
  }, [updateFlow, scheduleUpdate, triggerRedrawRef])

  // ResizeObserver to detect when node elements finish resizing/moving
  useEffect(() => {
    if (!containerRef.current) return

    const observer = new ResizeObserver(() => {
      // Debounce using requestAnimationFrame to avoid excessive calls
      scheduleUpdate()
    })

    const visibilityObserver = getSharedNodeObserver(scheduleUpdate)

    // Observe all visible node elements
    nodes.forEach(node => {
      const el = document.getElementById(`layer-node-${node.id}`)
      if (el) {
        observer.observe(el)
        if (visibilityObserver) visibilityObserver.observe(el)
      }
    })

    return () => {
      observer.disconnect()
      if (visibilityObserver) visibilityObserver.disconnect()
      globalVisibleNodes.clear()
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [nodes, expandedNodesArray, scheduleUpdate])

  // Attach scroll listener to the parent container for Viewport Edge Virtualization
  useEffect(() => {
    if (!containerRef.current) return
    const scrollParent = containerRef.current.closest('.overflow-y-auto') as HTMLElement
    if (!scrollParent) return

    let rafId: number | null = null
    const handleScroll = () => {
      if (rafId !== null) return // debounce
      rafId = requestAnimationFrame(() => {
        setViewport({
          scrollTop: scrollParent.scrollTop,
          clientHeight: scrollParent.clientHeight
        })
        rafId = null
      })
    }

    // Capture initial
    handleScroll()

    scrollParent.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('resize', handleScroll, { passive: true })

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      scrollParent.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
    }
  }, [])

  // Listeners for window resize and scroll
  useEffect(() => {
    // Initial draw with longer timeout to account for animation duration
    const timer = setTimeout(() => {
      requestAnimationFrame(() => {
        updateFlow()
      })
    }, 400)

    // Resize
    const handleResize = () => scheduleUpdate()
    window.addEventListener('resize', handleResize)

    // Scroll
    const handleScroll = () => scheduleUpdate()
    window.addEventListener('scroll', handleScroll, true)

    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
      clearTimeout(timer)
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [updateFlow, scheduleUpdate, expandedNodesArray])

  // VERY FAST Virtualization Filter: Only render edges that intersect the scroll viewport
  const VIEWPORT_MARGIN = 400 // Load edges slightly before they enter screen
  const visibleEdges = computedEdges.filter(edge => {
    // If edge bottom is above viewport OR edge top is below viewport -> Cull
    if (edge.maxY < viewport.scrollTop - VIEWPORT_MARGIN) return false
    if (edge.minY > viewport.scrollTop + viewport.clientHeight + VIEWPORT_MARGIN) return false
    return true
  })

  return (
    <>
    {/* ── VISUAL LAYER ─── z-[5]: behind node columns, no pointer events ── */}
    <div ref={containerRef} className="absolute inset-0 pointer-events-none z-[5]">
      <svg className="w-full h-full overflow-visible pointer-events-none">
        <defs>
          <style>
            {`
              @keyframes dashFlow {
                from { stroke-dashoffset: 400; }
                to { stroke-dashoffset: 0; }
              }
              .flow-particles {
                animation: dashFlow 20s linear infinite;
              }
              .flow-particles-ghost {
                animation: dashFlow 40s linear infinite; /* flows slower for ghosts */
              }
            `}
          </style>
          {/* arrowhead marker */}
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" opacity="0.8" />
          </marker>

          {/* Glow filter */}
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        {visibleEdges.map(edge => {
          const isHovered = hoveredEdgeId === edge.id
          const isSourceHovered = hoveredEdgeId === edge.source
          const isTargetHovered = hoveredEdgeId === edge.target
          // Highlight on hover OR when connected to the selected node
          const isHighlighted = isHovered || isSourceHovered || isTargetHovered || (isHighlightActive && highlightedEdges?.has(edge.id))
          const { pathD, color, dynamicStrokeWidth, edgeOpacity, isGhost, isBundled, sx, sy, tx, ty } = edge

          // When a node is selected, dim edges not connected to it to ~8%.
          // Connected edges stay full-strength with a brightness boost.
          const isConnectedToSelected = isHighlightActive && highlightedEdges?.has(edge.id)
          const groupOpacity = isHighlightActive
            ? (isConnectedToSelected ? 1 : 0.08)
            : 1

          return (
            <g
              key={edge.id}
              style={{ opacity: groupOpacity, transition: 'opacity 0.25s ease' }}
            >

              {/* BASE GLOW / DROP SHADOW - Thick and highly transparent */}
              <path
                d={pathD}
                style={{
                  stroke: color,
                  strokeWidth: dynamicStrokeWidth + (isHighlighted ? 4 : 2),
                  fill: 'none',
                  strokeOpacity: isHighlighted ? edgeOpacity * 0.4 : edgeOpacity * 0.15,
                  strokeLinecap: 'round',
                  transition: 'all 0.3s ease',
                }}
                className="pointer-events-none"
              />

              {/* CORE LINE - Solid but slightly translucent */}
              <path
                d={pathD}
                style={{
                  stroke: color,
                  strokeWidth: dynamicStrokeWidth,
                  fill: 'none',
                  strokeOpacity: isHighlighted ? Math.max(0.6, edgeOpacity * 1.5) : edgeOpacity,
                  strokeDasharray: isGhost ? '6 6' : 'none',
                  strokeLinecap: 'round',
                  transition: 'all 0.3s ease',
                }}
                className="pointer-events-none"
              />

              {/* ANIMATED PARTICLES / FLOW overlay */}
              {!isGhost && (
                <path
                  d={pathD}
                  style={{
                    stroke: color, // Use the vivid path color instead of white
                    strokeWidth: Math.max(1, dynamicStrokeWidth * 0.5),
                    fill: 'none',
                    strokeOpacity: isHighlighted ? 1 : 0.8,
                    strokeLinecap: 'round',
                    // CSS dasharray: small dash, huge gap -> acts like moving dots!
                    strokeDasharray: '4 16',
                    // Add a drop shadow strictly to the particles for a neon pop
                    filter: `drop-shadow(0 0 3px ${color})`
                  }}
                  className="pointer-events-none flow-particles"
                />
              )}
              {isGhost && (
                <path
                  d={pathD}
                  style={{
                    stroke: color,
                    strokeWidth: Math.max(1, dynamicStrokeWidth * 0.4),
                    fill: 'none',
                    strokeOpacity: isHighlighted ? 0.8 : 0.4,
                    strokeLinecap: 'round',
                    // Slow dash moving
                    strokeDasharray: '6 12',
                  }}
                  className="pointer-events-none flow-particles-ghost"
                />
              )}

              {/* Bundle Badge Label rendered on the path */}
              {isBundled && !isGhost && (
                <g transform={`translate(${(sx + tx) / 2}, ${(sy + ty) / 2})`}>
                  <rect x="-10" y="-8" width="20" height="16" rx="4" fill="currentColor" opacity="0.15" className="group-hover:opacity-30" />
                  <text x="0" y="3" fill="currentColor" fontSize="10px" fontWeight="bold" textAnchor="middle" opacity="0.9">
                    {edge.edgeCount}
                  </text>
                </g>
              )}

              {/* Terminals (Hide for ghosts to signify missing end) */}
              {!isGhost && (
                <circle cx={sx} cy={sy} r="2.5" fill="currentColor" style={{ opacity: edgeOpacity }} className="group-hover:opacity-80" />
              )}

              <title>{edge.source} → {edge.target} {isBundled ? `(${edge.edgeCount} bundled logs)` : ''}</title>
            </g>
          )
        })}
      </svg>
    </div>

    {/* ── HIT LAYER ─── z-20: above columns, transparent, only click/hover paths ── *
     *  Positioned identically to the visual layer but invisible. Sits above the    *
     *  z-10 column container so pointer events reach these paths correctly.        */}
    <div className="absolute inset-0 pointer-events-none z-20">
      <svg className="w-full h-full overflow-visible pointer-events-none">
        {visibleEdges.map(edge => {
          const { pathD } = edge
          return (
            <path
              key={`hit-${edge.id}`}
              d={pathD}
              fill="none"
              stroke="transparent"
              strokeWidth={14}
              className="pointer-events-auto cursor-pointer"
              data-canvas-interactive
              onMouseEnter={() => setHoveredEdgeId(edge.id)}
              onMouseLeave={() => setHoveredEdgeId(null)}
              onClick={(e) => {
                e.stopPropagation()
                selectEdge(edge.id)
                if (!isEdgePanelOpen) toggleEdgePanel()
              }}
            />
          )
        })}
      </svg>
    </div>
    </>
  )
}
