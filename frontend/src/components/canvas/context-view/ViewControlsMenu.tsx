/**
 * ViewControlsMenu — the single "View" trigger for Explore mode.
 *
 * Consolidates what used to be two separate header chips (LineageDisplayPopover
 * + DisplaySettingsPopover) behind one calm trigger. Opening it reveals both
 * the lineage rendering controls (only when the lineage mesh is on) and the
 * canvas display settings (zoom / density / badges / tree lines) as stacked
 * sections. This is the decluttering win for business users: one gear, not two.
 *
 * It reuses the exact section bodies from the standalone popovers
 * (`LineageDisplaySections`, `DisplaySettingsSections`) so there is zero visual
 * drift and no duplicated markup. The standalone popovers remain in use by
 * `LayerColumn`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, RotateCcw, Settings2, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { LineageDisplaySections } from './LineageDisplayPopover'
import { DisplaySettingsSections, isDisplaySettingsDefault } from './DisplaySettingsPopover'

const POPOVER_WIDTH = 320

interface ViewControlsMenuProps {
  // Lineage section — only shown when the mesh is on (otherwise these have no effect)
  showLineageFlow: boolean
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void
  showEdgeDirection: boolean
  onToggleEdgeDirection: () => void

  // Canvas display section
  canvasZoom: number
  onSetCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity
  onSetCanvasDensity: (density: CanvasDensity) => void
  showCanvasTypeBadge: boolean
  onToggleCanvasTypeBadge: () => void
  subtleCanvasTreeLines: boolean
  onToggleSubtleCanvasTreeLines: () => void
  onResetCanvasDisplaySettings: () => void
}

export function ViewControlsMenu({
  showLineageFlow,
  lineageRenderMode,
  onSetLineageRenderMode,
  showEdgeDirection,
  onToggleEdgeDirection,
  canvasZoom,
  onSetCanvasZoom,
  canvasDensity,
  onSetCanvasDensity,
  showCanvasTypeBadge,
  onToggleCanvasTypeBadge,
  subtleCanvasTreeLines,
  onToggleSubtleCanvasTreeLines,
  onResetCanvasDisplaySettings,
}: ViewControlsMenuProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const displayCustom = !isDisplaySettingsDefault({
    canvasZoom,
    canvasDensity,
    showTypeBadge: showCanvasTypeBadge,
    subtleTreeLines: subtleCanvasTreeLines,
  })

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setAnchor({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      const insideTrigger = triggerRef.current?.contains(target) ?? false
      const insidePopover = popoverRef.current?.contains(target) ?? false
      if (!insideTrigger && !insidePopover) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="View settings — lineage rendering and canvas display"
        className={cn(
          'flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition-all duration-300',
          open || displayCustom
            ? 'bg-accent-lineage/15 border border-accent-lineage/35 text-ink shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/30'
            : 'bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]',
        )}
      >
        <SlidersHorizontal className="w-4 h-4" strokeWidth={2.2} />
        <span>View</span>
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {open && anchor && (
            <motion.div
              ref={popoverRef}
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              role="dialog"
              aria-label="View settings"
              style={{ position: 'fixed', top: anchor.top, right: anchor.right, width: POPOVER_WIDTH, zIndex: 1000 }}
              className="rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden max-h-[min(560px,80vh)] overflow-y-auto"
            >
              {/* Title bar */}
              <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04] sticky top-0 bg-canvas-elevated/95 backdrop-blur-xl z-10">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
                  <Settings2 className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                </div>
                <div className="text-[12px] font-semibold text-ink tracking-tight">View Settings</div>
                {displayCustom && (
                  <button
                    type="button"
                    onClick={onResetCanvasDisplaySettings}
                    className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                    title="Reset canvas display settings"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset
                  </button>
                )}
              </div>

              {/* Lineage section — only when the mesh is rendering */}
              {showLineageFlow && (
                <>
                  <div className="px-3 pt-2.5 -mb-1 text-[10px] font-bold tracking-[0.12em] uppercase text-accent-lineage/70">
                    Lineage
                  </div>
                  <LineageDisplaySections
                    lineageRenderMode={lineageRenderMode}
                    onSetLineageRenderMode={onSetLineageRenderMode}
                    showEdgeDirection={showEdgeDirection}
                    onToggleEdgeDirection={onToggleEdgeDirection}
                  />
                  <div className="h-px bg-black/[0.10] dark:bg-white/[0.08] mx-3 my-1" />
                </>
              )}

              {/* Canvas display section */}
              <div className="px-3 pt-2.5 -mb-1 text-[10px] font-bold tracking-[0.12em] uppercase text-accent-lineage/70">
                Canvas
              </div>
              <DisplaySettingsSections
                canvasZoom={canvasZoom}
                onSetCanvasZoom={onSetCanvasZoom}
                canvasDensity={canvasDensity}
                onSetCanvasDensity={onSetCanvasDensity}
                showTypeBadge={showCanvasTypeBadge}
                onToggleTypeBadge={onToggleCanvasTypeBadge}
                subtleTreeLines={subtleCanvasTreeLines}
                onToggleSubtleTreeLines={onToggleSubtleCanvasTreeLines}
              />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}
