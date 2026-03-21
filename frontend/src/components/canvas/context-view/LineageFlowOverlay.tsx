import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import type { ComputedEdge } from './types'

// Global visibility tracker — which layer-node-* elements are currently in the viewport
const globalVisibleNodes = new Set<string>()

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

        // Relative coordinates — offset from column edges so curves are visible
        // in the gutter between columns (gap-12 = 48px gap)
        const sx = sRect.right - containerRect.left + 6
        const sy = sRect.top + sRect.height / 2 - containerRect.top

        // Target: leave room for the arrowhead
        let tx = tRect.left - containerRect.left - 8
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
          const dist = Math.abs(tx - sx)

          // Ensure minimum control point spread so short-distance edges
          // (adjacent columns with ~48px gap) still show a visible curve
          const minSpread = 24
          const spread = Math.max(dist * 0.5, minSpread)

          const cp1x = sx + spread
          const cp2x = tx - spread

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
        // Base opacity — high enough to be clearly visible; confidence modulates it
        let edgeOpacity = 0.6 + (edge.confidence || 0.4) * 0.4

        // Base stroke width — thick enough to be clearly visible between columns
        let baseStrokeWidth = 1.8
        if (edge.isBundled) {
          // Logarithmic scaling — stays elegant even at high counts
          baseStrokeWidth = Math.min(2 + Math.log2(edge.edgeCount) * 0.6, 4)
        } else if (edge.isAggregated) {
          baseStrokeWidth = 2.2
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
            // Full intensity when hovering or clicking a connected node
            edgeOpacity = 0.9
            dynamicStrokeWidth = baseStrokeWidth + 1
          } else if (isEdgeDimmed) {
            edgeOpacity = edge.isGhost ? 0.05 : 0.1
            dynamicStrokeWidth = Math.max(1, baseStrokeWidth - 1)
          } else {
            // Resting state: half intensity — edges are present but subtle,
            // hover/click on a node brings connected edges to full strength
            edgeOpacity = edgeOpacity * 0.5
            dynamicStrokeWidth = baseStrokeWidth * 0.75
          }
        }

        // Ghost styling for abstracted/bundled edges
        if (edge.isGhost) {
          edgeOpacity = Math.min(0.7, edgeOpacity)
        }

        // Edge delegation: expanded parents delegate edges to visible children.
        // isDelegated = fully delegated (all children loaded) → hide entirely
        // isResidual  = partially loaded → show as faint ghost to hint at unloaded lineage
        if (edge.isDelegated) {
          // Skip entirely — children carry these edges now
          return
        }
        if (edge.isResidual) {
          edgeOpacity = 0.15
          dynamicStrokeWidth = Math.max(1, baseStrokeWidth * 0.7)
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
          sx, sy, tx, ty,
          types: Array.isArray(edge.types) && edge.types.length > 0
            ? edge.types
            : edge.originalType ? [edge.originalType] : [],
          confidence: edge.confidence || 0,
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

  // ResizeObserver + IntersectionObserver for node elements.
  // Uses MutationObserver to dynamically track layer-node-* elements as they're
  // added/removed by the virtualizer (which mounts/unmounts DOM elements on scroll).
  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current

    const resizeObserver = new ResizeObserver(() => {
      scheduleUpdate()
    })

    // Fresh IntersectionObserver per effect lifecycle (no stale singleton)
    const visibilityObserver = new IntersectionObserver((entries) => {
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
      if (changed) scheduleUpdate()
    }, {
      root: null,
      rootMargin: '100px',
      threshold: 0,
    })

    // Track which elements we're currently observing
    const observedElements = new Set<Element>()

    const observeElement = (el: Element) => {
      if (observedElements.has(el)) return
      observedElements.add(el)
      resizeObserver.observe(el)
      visibilityObserver.observe(el)
    }

    const unobserveElement = (el: Element) => {
      if (!observedElements.has(el)) return
      observedElements.delete(el)
      resizeObserver.unobserve(el)
      visibilityObserver.unobserve(el)
      if (el.id) globalVisibleNodes.delete(el.id)
    }

    // The overlay is a sibling of the layer columns, so we need to observe
    // the common parent that contains both.
    const observeRoot = container.parentElement || container

    // Scan for already-present node elements
    const scanAndObserve = () => {
      observeRoot.querySelectorAll('[id^="layer-node-"]').forEach(el => observeElement(el))
    }
    scanAndObserve()

    // Re-scan after next frame — virtualizer may mount items slightly after this effect runs
    const scanRaf = requestAnimationFrame(() => {
      scanAndObserve()
      scheduleUpdate()
    })

    // MutationObserver to pick up elements added/removed by the virtualizer
    const mutationObserver = new MutationObserver((mutations) => {
      let changed = false
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) {
          if (added instanceof HTMLElement) {
            if (added.id?.startsWith('layer-node-')) {
              observeElement(added)
              changed = true
            }
            added.querySelectorAll('[id^="layer-node-"]').forEach(el => {
              observeElement(el)
              changed = true
            })
          }
        }
        for (const removed of mutation.removedNodes) {
          if (removed instanceof HTMLElement) {
            if (removed.id?.startsWith('layer-node-')) {
              unobserveElement(removed)
              changed = true
            }
            removed.querySelectorAll('[id^="layer-node-"]').forEach(el => {
              unobserveElement(el)
              changed = true
            })
          }
        }
      }
      if (changed) scheduleUpdate()
    })

    mutationObserver.observe(observeRoot, { childList: true, subtree: true })

    return () => {
      cancelAnimationFrame(scanRaf)
      mutationObserver.disconnect()
      resizeObserver.disconnect()
      visibilityObserver.disconnect()
      observedElements.clear()
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

  // ── 4.2 Hover Preview ────────────────────────────────────────────────────────
  // Pure DOM/CSS — zero React re-renders. Reads document.dataset.hoveredNode set
  // by FlatTreeItem, then dims/highlights visual edge <g> elements directly.
  useEffect(() => {
    let rafId: number
    let lastNode: string | undefined

    const tick = () => {
      const hovered = document.documentElement.dataset.hoveredNode
      if (hovered !== lastNode) {
        lastNode = hovered
        const groups = containerRef.current?.querySelectorAll<SVGGElement>('g[data-edge-id]')
        groups?.forEach(g => {
          if (!hovered) {
            g.style.removeProperty('opacity')
          } else if (g.dataset.edgeSrc === hovered || g.dataset.edgeTgt === hovered) {
            g.style.opacity = '1'
          } else {
            g.style.opacity = '0.06'
          }
        })
      }
      rafId = requestAnimationFrame(tick)
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

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
              data-edge-id={edge.id}
              data-edge-src={edge.source}
              data-edge-tgt={edge.target}
              style={{ opacity: groupOpacity, transition: 'opacity 0.25s ease' }}
            >

              {/* SUBTLE GLOW — only on highlight, thin halo */}
              {isHighlighted && (
                <path
                  d={pathD}
                  style={{
                    stroke: color,
                    strokeWidth: dynamicStrokeWidth + 2,
                    fill: 'none',
                    strokeOpacity: edgeOpacity * 0.2,
                    strokeLinecap: 'round',
                    transition: 'all 0.3s ease',
                  }}
                  className="pointer-events-none"
                />
              )}

              {/* CORE LINE */}
              <path
                d={pathD}
                style={{
                  stroke: color,
                  strokeWidth: dynamicStrokeWidth,
                  fill: 'none',
                  strokeOpacity: isHighlighted ? Math.min(0.95, edgeOpacity * 1.2) : edgeOpacity,
                  strokeDasharray: isGhost ? '6 4' : 'none',
                  strokeLinecap: 'round',
                  transition: 'all 0.3s ease',
                }}
                markerEnd={!isGhost ? `url(#arrowhead-${edge.id})` : undefined}
                className="pointer-events-none"
              />

              {/* ANIMATED PARTICLES — only on hover/highlight, minimal */}
              {!isGhost && isHighlighted && (
                <path
                  d={pathD}
                  style={{
                    stroke: color,
                    strokeWidth: Math.max(0.75, dynamicStrokeWidth * 0.35),
                    fill: 'none',
                    strokeOpacity: 0.6,
                    strokeLinecap: 'round',
                    strokeDasharray: '2 18',
                  }}
                  className="pointer-events-none flow-particles"
                />
              )}
              {isGhost && (
                <path
                  d={pathD}
                  style={{
                    stroke: color,
                    strokeWidth: Math.max(0.75, dynamicStrokeWidth * 0.35),
                    fill: 'none',
                    strokeOpacity: isHighlighted ? 0.5 : 0.25,
                    strokeLinecap: 'round',
                    strokeDasharray: '4 10',
                  }}
                  className="pointer-events-none flow-particles-ghost"
                />
              )}

              {/* Bundle count — minimal pill */}
              {isBundled && !isGhost && (
                <g transform={`translate(${(sx + tx) / 2}, ${(sy + ty) / 2})`}>
                  <rect x="-8" y="-6" width="16" height="12" rx="6" fill="currentColor" opacity="0.08" />
                  <text x="0" y="3" fill="currentColor" fontSize="8px" fontWeight="500" textAnchor="middle" opacity="0.6">
                    {edge.edgeCount}
                  </text>
                </g>
              )}

              {/* Arrowhead marker (per-edge, inherits edge color) */}
              <defs>
                <marker
                  id={`arrowhead-${edge.id}`}
                  markerWidth="8"
                  markerHeight="6"
                  refX="7"
                  refY="3"
                  orient="auto"
                >
                  <polygon
                    points="0 0.5, 7 3, 0 5.5"
                    fill={color}
                    opacity={isHighlighted ? 0.9 : edgeOpacity * 0.85}
                  />
                </marker>
              </defs>

              {/* Source terminal dot */}
              {!isGhost && (
                <circle cx={sx} cy={sy} r={isHighlighted ? 3 : 2.5} fill={color} style={{ opacity: edgeOpacity * 0.8, transition: 'r 0.2s ease' }} />
              )}

              <title>{edge.source} → {edge.target} {isBundled ? `(${edge.edgeCount} bundled logs)` : ''}</title>
            </g>
          )
        })}
      </svg>

      {/* ── 4.4 Edge Tooltip ───────────────────────────────────────────────────── */}
      {(() => {
        if (!hoveredEdgeId) return null
        const edge = computedEdges.find(e => e.id === hoveredEdgeId)
        if (!edge) return null
        const midX = (edge.sx + edge.tx) / 2
        const midY = (edge.sy + edge.ty) / 2
        const typeLabel = edge.types.length > 0 ? edge.types.join(' · ') : 'RELATIONSHIP'
        const confPct = edge.confidence > 0 ? Math.round(edge.confidence * 100) : null

        // Flip tooltip left if too close to right edge
        const tooltipX = midX + 14
        const tooltipY = midY - 44

        return (
          <div
            className="absolute pointer-events-none"
            style={{ left: tooltipX, top: tooltipY, zIndex: 100 }}
          >
            <div
              className="rounded-xl border border-white/[0.12] shadow-2xl shadow-black/60 px-3 py-2.5 min-w-[140px] max-w-[220px]"
              style={{
                background: 'rgba(15, 17, 23, 0.92)',
                backdropFilter: 'blur(12px)',
              }}
            >
              {/* type chip */}
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-3 h-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: edge.color }} />
                <span className="text-[11px] font-semibold tracking-wide" style={{ color: edge.color }}>
                  {typeLabel}
                </span>
              </div>

              {/* bundle count */}
              {edge.edgeCount > 1 && (
                <p className="text-[10px] text-white/60 leading-snug">
                  {edge.edgeCount.toLocaleString()} relationships bundled
                </p>
              )}

              {/* confidence */}
              {confPct !== null && (
                <div className="flex items-center gap-1.5 mt-1">
                  <div className="flex-1 h-0.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${confPct}%`, backgroundColor: edge.color, opacity: 0.7 }}
                    />
                  </div>
                  <span className="text-[10px] text-white/50 tabular-nums flex-shrink-0">{confPct}%</span>
                </div>
              )}

              {/* hint */}
              <p className="text-[9px] text-white/30 mt-1.5 pt-1.5 border-t border-white/[0.06]">
                Click to inspect
              </p>
            </div>
          </div>
        )
      })()}
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
