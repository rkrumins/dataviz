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
 *
 * `CanvasDisplayMenu` is the same trigger and popover on the Graph and
 * Hierarchy canvases, with what they can change about how they draw.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  ChevronDown, Eye, EyeOff, Grid3X3, Map as MapIcon, Minus, Plus, RotateCcw, Settings2, Sliders, SlidersHorizontal,
  Unlink, Wrench, ZoomIn,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { usePreferencesStore, type CanvasDensity, type LineageRenderMode } from '@/store/preferences'
import { usePersonaMode } from '@/store/persona'
import { CollapsibleSection, DisplaySettingsSections, ToggleRow, isDefaultState } from '../DisplaySettingsPopover'
import { LineageDisplaySections } from '../LineageDisplayPopover'
import { useFolded } from './toolbarFold'

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

  /** Opens the orphaned-entities panel. Absent = no Advanced section. */
  onOpenOrphans?: () => void
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
  onOpenOrphans,
}: DisplayMenuProps) {
  // Defense-in-depth defaults — see DisplaySettingsPopover for rationale.
  const canvasZoom = canvasZoomRaw ?? 1
  const canvasDensity: CanvasDensity = canvasDensityRaw ?? 'spacious'
  const showTypeBadge = showTypeBadgeRaw ?? true
  const subtleTreeLines = subtleTreeLinesRaw ?? false

  const showEntityIcons = usePreferencesStore((s) => s.showCanvasEntityIcons) ?? true
  const showEntityIds = usePreferencesStore((s) => s.showCanvasEntityIds) ?? true
  const showMemoryUsage = usePreferencesStore((s) => s.showMemoryUsage) ?? false
  const lineagePortSides = usePreferencesStore((s) => s.lineagePortSides) ?? 'direction'
  // The Business view's Display is the canvas and how many lines it draws; how
  // they move, their arrows and their markers, and the Advanced tools, are the
  // Technical view's.
  const technical = usePersonaMode() === 'technical'
  const setLineagePortSides = usePreferencesStore((s) => s.setLineagePortSides)
  // The entity IDs switch is the Technical view's: IDs hidden there are no reason for Business to offer Reset.
  const isCustom = !isDefaultState({
    canvasZoom, canvasDensity, showTypeBadge, subtleTreeLines, showEntityIcons, showMemoryUsage,
    showEntityIds: !technical || showEntityIds,
  })

  return (
    <DisplayPopover label="Change how the canvas is drawn — zoom, density, badges and lineage">
      {(close) => (
        <>
          {/* Section: Canvas */}
          <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04]">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
              <Settings2 className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
            </div>
            <div className="text-[12px] font-semibold text-ink tracking-tight">Canvas</div>
            {isCustom && (
              <HoverTip
                className="ml-auto inline-flex"
                label="Put zoom, density, icons, IDs, badges, tree lines and the memory gauge back to their defaults"
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
            simple={!technical}
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
              {technical ? 'Turn on Lineage to adjust edge appearance' : 'Turn on Lineage to change how lines are drawn'}
            </p>
          )}

          <LineageDisplaySections
            lineageRenderMode={lineageRenderMode}
            onSetLineageRenderMode={onSetLineageRenderMode}
            showEdgeDirection={showEdgeDirection}
            onToggleEdgeDirection={onToggleEdgeDirection}
            lineagePortSides={lineagePortSides}
            onSetLineagePortSides={setLineagePortSides}
            disabled={!lineageEnabled}
            simple={!technical}
          />

          {technical && onOpenOrphans && (
            <>
              <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

              {/* Section: Advanced — power-user tools, kept last so the
                  everyday settings stay first. */}
              <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04]">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
                  <Wrench className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                </div>
                <div className="text-[12px] font-semibold text-ink tracking-tight">Advanced</div>
              </div>

              <div className="p-2">
                <HoverTip
                  className="flex"
                  label="List entities with no parent in the data whose type normally sits inside another"
                  detail="Opens a side panel — the canvas stays as it is"
                >
                  <button
                    type="button"
                    onClick={() => { close(); onOpenOrphans() }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                  >
                    <Unlink className="w-3.5 h-3.5" />
                    Orphaned entities…
                  </button>
                </HoverTip>
              </div>
            </>
          )}
        </>
      )}
    </DisplayPopover>
  )
}

/** The Display trigger and its popover; `children` draws the popover's body,
 *  handed a way to close it. */
function DisplayPopover({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false)
  const folded = useFolded('display')
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

  return (
    <>
      <HoverTip
        className="inline-flex"
        label={label}
        detail="Affects what you see, never the view itself"
      >
      <button
        ref={triggerRef}
        data-tour="canvas-display"
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-toolbar-item="display"
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition duration-300',
          open
            ? 'bg-accent-lineage/15 border border-accent-lineage/35 text-ink shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/30'
            : 'bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]',
          folded && 'px-2.5',
        )}
      >
        <SlidersHorizontal className="w-4 h-4" strokeWidth={2.2} />
        <span data-toolbar-label className={folded ? 'sr-only' : undefined}>Display</span>
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
              className="flex flex-col rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden"
            >
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                {children(() => setOpen(false))}
              </div>
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </>
  )
}

export interface CanvasDisplayMenuProps {
  /** The Graph's zoom. Absent on a canvas without one (the Hierarchy). */
  zoom?: { onZoomIn: () => void; onZoomOut: () => void; onFit: () => void }
  /** The Graph's minimap and dot grid switches. */
  mapAndGrid?: boolean
}

const ZOOM_BUTTON = 'flex-shrink-0 h-7 rounded-lg flex items-center justify-center border transition-colors '
  + 'bg-black/[0.04] border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08]'

/**
 * Display on the Graph and Hierarchy canvases: the Graph's zoom, minimap and
 * dot grid (its Technical-only Canvas Controls once held them) and, on both,
 * each entity's ID — the Technical view's, as on the Context View — and its
 * type badge.
 */
export function CanvasDisplayMenu({ zoom, mapAndGrid = false }: CanvasDisplayMenuProps) {
  const technical = usePersonaMode() === 'technical'
  const showEntityIds = usePreferencesStore((s) => s.showCanvasEntityIds) ?? true
  const toggleEntityIds = usePreferencesStore((s) => s.toggleCanvasEntityIds)
  const showTypeBadge = usePreferencesStore((s) => s.showCanvasTypeBadge) ?? true
  const toggleTypeBadge = usePreferencesStore((s) => s.toggleCanvasTypeBadge)
  const showMinimap = usePreferencesStore((s) => s.showMinimap)
  const toggleMinimap = usePreferencesStore((s) => s.toggleMinimap)
  const showGrid = usePreferencesStore((s) => s.showGrid)
  const toggleGrid = usePreferencesStore((s) => s.toggleGrid)
  const switchesOn = [technical && showEntityIds, showTypeBadge, mapAndGrid && showMinimap, mapAndGrid && showGrid]
    .filter(Boolean).length

  return (
    <DisplayPopover label={zoom
      ? 'Change how the graph is drawn — zoom, IDs, badges, minimap and grid'
      : 'Change how the rows are drawn — IDs and type badges'}
    >
      {() => (
        <>
          <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04]">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
              <Settings2 className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
            </div>
            <div className="text-[12px] font-semibold text-ink tracking-tight">Canvas</div>
          </div>

          {zoom && (
            <>
              <CollapsibleSection id="graph-zoom" icon={ZoomIn} title="Zoom">
                <div className="flex items-center gap-2 px-1 pt-2 pb-1">
                  <button type="button" onClick={zoom.onZoomOut} aria-label="Zoom out" className={cn(ZOOM_BUTTON, 'w-7')}>
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={zoom.onZoomIn} aria-label="Zoom in" className={cn(ZOOM_BUTTON, 'w-7')}>
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={zoom.onFit} className={cn(ZOOM_BUTTON, 'px-2.5 text-[10.5px] font-semibold')}>
                    Fit the graph
                  </button>
                </div>
              </CollapsibleSection>
              <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />
            </>
          )}

          <CollapsibleSection id="graph-chrome" icon={Eye} title="Display options" summary={`${switchesOn} on`}>
            <div className="pt-1.5 space-y-1.5">
              {technical && (
                <ToggleRow
                  label="Show entity IDs"
                  description="Each entity’s ID under its name"
                  icon={showEntityIds ? Eye : EyeOff}
                  active={showEntityIds}
                  onClick={toggleEntityIds}
                  accent="cyan"
                />
              )}
              <ToggleRow
                label="Show entity type badge"
                description={showTypeBadge ? 'Type label shown above each name' : 'Type label hidden'}
                icon={showTypeBadge ? Eye : EyeOff}
                active={showTypeBadge}
                onClick={toggleTypeBadge}
                accent="cyan"
              />
              {mapAndGrid && (
                <>
                  <ToggleRow
                    label="Show minimap"
                    description="An overview of the whole graph, bottom right"
                    icon={MapIcon}
                    active={showMinimap}
                    onClick={toggleMinimap}
                    accent="purple"
                  />
                  <ToggleRow
                    label="Show dot grid"
                    description="Dots behind the graph"
                    icon={Grid3X3}
                    active={showGrid}
                    onClick={toggleGrid}
                    accent="purple"
                  />
                </>
              )}
            </div>
          </CollapsibleSection>
        </>
      )}
    </DisplayPopover>
  )
}
