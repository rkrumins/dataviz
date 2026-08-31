/**
 * DisplayMenu — the Context View header's single "Display" popover.
 *
 * Consolidates what used to be two separate header chips —
 * DisplaySettingsPopover (canvas zoom/density/badges) and
 * LineageDisplayPopover (edge density/direction) — behind one trigger, so
 * the toolbar doesn't ask users to hunt across two lookalike buttons for
 * display controls. Composed from the sections each original popover
 * already exports (`DisplaySettingsSections`, `LineageDisplaySections`);
 * this file owns only the trigger, shell, and section headers.
 *
 * Unlike the old LineageDisplayPopover (hidden entirely when Lineage was
 * off), the Lineage appearance section here always renders — muted and
 * inert via `lineageEnabled={false}` — so users can discover it exists.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ChevronDown, RotateCcw, Settings2, Sliders, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { DisplaySettingsSections, isDefaultState } from '../DisplaySettingsPopover'
import { LineageDisplaySections } from '../LineageDisplayPopover'

export interface DisplayMenuProps {
  // Canvas — zoom / density / badges / tree lines
  canvasZoom: number | undefined
  onSetCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity | undefined
  onSetCanvasDensity: (density: CanvasDensity) => void
  showTypeBadge: boolean | undefined
  onToggleTypeBadge: () => void
  subtleTreeLines: boolean | undefined
  onToggleSubtleTreeLines: () => void
  onReset: () => void
  /** Fit all layer columns into the viewport width (Cmd/Ctrl+0). */
  onFitToWidth?: () => void

  // Lineage appearance — edge density / direction arrows
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void
  showEdgeDirection: boolean
  onToggleEdgeDirection: () => void

  /** When false, the Lineage appearance section renders muted + inert with
   *  a one-line hint, instead of being hidden outright. */
  lineageEnabled: boolean
}

const POPOVER_WIDTH = 320

export function DisplayMenu({
  canvasZoom: canvasZoomRaw,
  onSetCanvasZoom,
  canvasDensity: canvasDensityRaw,
  onSetCanvasDensity,
  showTypeBadge: showTypeBadgeRaw,
  onToggleTypeBadge,
  subtleTreeLines: subtleTreeLinesRaw,
  onToggleSubtleTreeLines,
  onReset,
  onFitToWidth,
  lineageRenderMode,
  onSetLineageRenderMode,
  showEdgeDirection,
  onToggleEdgeDirection,
  lineageEnabled,
}: DisplayMenuProps) {
  // Defense-in-depth defaults — see DisplaySettingsPopover for rationale.
  const canvasZoom = canvasZoomRaw ?? 1
  const canvasDensity: CanvasDensity = canvasDensityRaw ?? 'spacious'
  const showTypeBadge = showTypeBadgeRaw ?? true
  const subtleTreeLines = subtleTreeLinesRaw ?? false

  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setAnchor({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      })
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

  const isCustom = !isDefaultState({ canvasZoom, canvasDensity, showTypeBadge, subtleTreeLines })

  return (
    <>
      <HoverTip
        className="inline-flex"
        label="Change how the canvas is drawn — zoom, density, badges and lineage"
        detail="Affects what you see, never the view itself"
      >
      <button
        ref={triggerRef}
        data-tour="canvas-display"
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300',
          open
            ? 'bg-accent-lineage/15 border border-accent-lineage/35 text-ink shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/30'
            : 'bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]',
        )}
      >
        <SlidersHorizontal className="w-4 h-4" strokeWidth={2.2} />
        <span>Display</span>
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      </HoverTip>

      {/* Portal escapes the header's stacking context (it has backdrop-filter,
          which creates one) so the popover is layered above the canvas body
          and reliably receives clicks. */}
      {/* No AnimatePresence: the popover unmounts instantly on close so an
          interrupted exit can never strand an invisible click-blocker at
          z-1000 over the toolbar. It still animates in. */}
      {typeof document !== 'undefined' && createPortal(
        <>
          {open && anchor && (
            <motion.div
              ref={popoverRef}
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
              role="dialog"
              aria-label="Display"
              style={{
                position: 'fixed',
                top: anchor.top,
                right: anchor.right,
                width: POPOVER_WIDTH,
                zIndex: 1000,
                // The menu can outgrow the window (Canvas + Lineage
                // sections) — cap it to the space below the trigger and
                // let the BODY scroll. Without this it clipped with no
                // way to reach the lower settings.
                maxHeight: `calc(100vh - ${anchor.top}px - 16px)`,
              }}
              className="flex flex-col rounded-xl bg-canvas-elevated backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden"
            >
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
              {/* Section: Canvas */}
              <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04]">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
                  <Settings2 className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                </div>
                <div className="text-[12px] font-semibold text-ink tracking-tight">Canvas</div>
                {isCustom && (
                  <HoverTip
                    className="ml-auto inline-flex"
                    label="Put zoom, density, badges and lineage appearance back to their defaults"
                  >
                    <button
                      type="button"
                      onClick={onReset}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reset
                    </button>
                  </HoverTip>
                )}
              </div>

              <DisplaySettingsSections
                canvasZoom={canvasZoom}
                onSetCanvasZoom={onSetCanvasZoom}
                canvasDensity={canvasDensity}
                onSetCanvasDensity={onSetCanvasDensity}
                showTypeBadge={showTypeBadge}
                onToggleTypeBadge={onToggleTypeBadge}
                subtleTreeLines={subtleTreeLines}
                onToggleSubtleTreeLines={onToggleSubtleTreeLines}
                onFitToWidth={onFitToWidth}
              />

              <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

              {/* Section: Lineage appearance */}
              <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04]">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
                  <Sliders className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                </div>
                <div className="text-[12px] font-semibold text-ink tracking-tight">Lineage appearance</div>
              </div>

              {!lineageEnabled && (
                <p className="px-3 pt-2 pb-1 text-[11px] text-ink-muted/70 leading-snug">
                  Turn on Lineage to adjust edge appearance
                </p>
              )}

              <LineageDisplaySections
                lineageRenderMode={lineageRenderMode}
                onSetLineageRenderMode={onSetLineageRenderMode}
                showEdgeDirection={showEdgeDirection}
                onToggleEdgeDirection={onToggleEdgeDirection}
                disabled={!lineageEnabled}
              />
              </div>
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </>
  )
}
