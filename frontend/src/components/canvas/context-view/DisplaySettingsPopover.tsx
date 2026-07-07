/**
 * DisplaySettingsPopover — canvas display preferences for the Context View
 * toolbar. Houses four grouped controls:
 *
 *   1. Zoom — CSS scale on the layers area (75–150%)
 *   2. Density — compact / comfortable / spacious row sizing
 *   3. Entity type badge — show/hide the type pill under each row
 *   4. Subtle tree lines — dim the indent connectors
 *
 * Visually mirrors LineageDisplayPopover so the two header chips read as a
 * matched pair (same portal pattern, framer-motion entrance, trigger shape).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ChevronDown,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  Minus,
  Plus,
  RotateCcw,
  Rows3,
  Settings2,
  Sparkles,
  ZoomIn,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_STEP,
  type CanvasDensity,
} from '@/store/preferences'

interface DisplaySettingsPopoverProps {
  canvasZoom: number | undefined
  onSetCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity | undefined
  onSetCanvasDensity: (density: CanvasDensity) => void
  showTypeBadge: boolean | undefined
  onToggleTypeBadge: () => void
  subtleTreeLines: boolean | undefined
  onToggleSubtleTreeLines: () => void
  onReset: () => void
}

interface DensityOption {
  mode: CanvasDensity
  label: string
  description: string
  icon: typeof Minimize
}

const DENSITY_OPTIONS: DensityOption[] = [
  { mode: 'compact', label: 'Compact', description: 'Tightest rows — fit more on screen', icon: Minimize },
  { mode: 'comfortable', label: 'Comfortable', description: 'Balanced spacing', icon: Rows3 },
  { mode: 'spacious', label: 'Spacious', description: 'Larger rows and icons for readability (default)', icon: Maximize },
]

const POPOVER_WIDTH = 320

function formatZoom(z: number): string {
  return `${Math.round(z * 100)}%`
}

export function isDefaultState(props: {
  canvasZoom: number
  canvasDensity: CanvasDensity
  showTypeBadge: boolean
  subtleTreeLines: boolean
}): boolean {
  return (
    Math.abs(props.canvasZoom - 1) < 0.001 &&
    props.canvasDensity === 'spacious' &&
    props.showTypeBadge === true &&
    props.subtleTreeLines === false
  )
}

export function DisplaySettingsPopover({
  canvasZoom: canvasZoomRaw,
  onSetCanvasZoom,
  canvasDensity: canvasDensityRaw,
  onSetCanvasDensity,
  showTypeBadge: showTypeBadgeRaw,
  onToggleTypeBadge,
  subtleTreeLines: subtleTreeLinesRaw,
  onToggleSubtleTreeLines,
  onReset,
}: DisplaySettingsPopoverProps) {
  // Defense-in-depth defaults: persisted state from earlier app versions
  // may surface these fields as `undefined` during hydration. The parent
  // already nullish-coalesces, but a missing default here would crash the
  // trigger render (e.g. `canvasDensity[0]`) before the parent can heal.
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
  const zoomPct = formatZoom(canvasZoom)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Display settings — zoom, density, badges, tree lines"
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all duration-300',
          open || isCustom
            ? 'bg-accent-lineage/15 border border-accent-lineage/35 text-ink shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/30'
            : 'bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]',
        )}
      >
        <Settings2 className="w-3.5 h-3.5" />
        <span className="flex items-center gap-1 tabular-nums">
          <ZoomIn className="w-3 h-3 text-accent-lineage/80 dark:text-accent-lineage" strokeWidth={2.4} />
          <span className="text-accent-lineage font-semibold">{zoomPct}</span>
          <span className="opacity-30 mx-0.5">·</span>
          <Rows3 className="w-3 h-3 text-accent-lineage/80 dark:text-accent-lineage" strokeWidth={2.4} />
          <span className="text-accent-lineage font-semibold capitalize">{canvasDensity[0]}</span>
        </span>
        <ChevronDown
          className={cn('w-3 h-3 transition-transform duration-200', open && 'rotate-180')}
        />
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
              aria-label="Display settings"
              style={{
                position: 'fixed',
                top: anchor.top,
                right: anchor.right,
                width: POPOVER_WIDTH,
                zIndex: 1000,
              }}
              className="rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden"
            >
              {/* Title bar */}
              <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04]">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
                  <Sparkles className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                </div>
                <div className="text-[12px] font-semibold text-ink tracking-tight">Display Settings</div>
                {isCustom && (
                  <button
                    type="button"
                    onClick={onReset}
                    className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                    title="Reset all display settings"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset
                  </button>
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
              />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  )
}

interface DisplaySettingsSectionsProps {
  canvasZoom: number
  onSetCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity
  onSetCanvasDensity: (density: CanvasDensity) => void
  showTypeBadge: boolean
  onToggleTypeBadge: () => void
  subtleTreeLines: boolean
  onToggleSubtleTreeLines: () => void
}

/**
 * DisplaySettingsSections — the Zoom / Density / Toggles body shared by the
 * standalone DisplaySettingsPopover and the header's consolidated
 * DisplayMenu. Pure content, no trigger/shell/title-bar of its own.
 */
export function DisplaySettingsSections({
  canvasZoom,
  onSetCanvasZoom,
  canvasDensity,
  onSetCanvasDensity,
  showTypeBadge,
  onToggleTypeBadge,
  subtleTreeLines,
  onToggleSubtleTreeLines,
}: DisplaySettingsSectionsProps) {
  const zoomPct = formatZoom(canvasZoom)
  const canZoomOut = canvasZoom > CANVAS_ZOOM_MIN + 0.001
  const canZoomIn = canvasZoom < CANVAS_ZOOM_MAX - 0.001

  return (
    <>
      {/* Zoom */}
      <div className="px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-[0.1em] uppercase text-ink-muted/80">
          <ZoomIn className="w-3 h-3" />
          <span>Zoom</span>
          <span className="ml-auto tabular-nums text-accent-lineage/80">{zoomPct}</span>
        </div>
        <div className="flex items-center gap-2 px-1 pt-2 pb-1">
          <button
            type="button"
            onClick={() => onSetCanvasZoom(canvasZoom - CANVAS_ZOOM_STEP)}
            disabled={!canZoomOut}
            className={cn(
              'flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center border transition-colors',
              canZoomOut
                ? 'bg-black/[0.04] border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08]'
                : 'bg-black/[0.02] border-black/[0.06] text-ink-muted/30 cursor-not-allowed dark:bg-white/[0.02] dark:border-white/[0.04]',
            )}
            aria-label="Zoom out"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <input
            type="range"
            min={CANVAS_ZOOM_MIN}
            max={CANVAS_ZOOM_MAX}
            step={CANVAS_ZOOM_STEP}
            value={canvasZoom}
            onChange={(e) => onSetCanvasZoom(parseFloat(e.target.value))}
            className="flex-1 accent-accent-lineage"
            aria-label="Canvas zoom"
          />
          <button
            type="button"
            onClick={() => onSetCanvasZoom(canvasZoom + CANVAS_ZOOM_STEP)}
            disabled={!canZoomIn}
            className={cn(
              'flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center border transition-colors',
              canZoomIn
                ? 'bg-black/[0.04] border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08]'
                : 'bg-black/[0.02] border-black/[0.06] text-ink-muted/30 cursor-not-allowed dark:bg-white/[0.02] dark:border-white/[0.04]',
            )}
            aria-label="Zoom in"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onSetCanvasZoom(1)}
            className="flex-shrink-0 px-2 h-7 rounded-lg text-[10.5px] font-semibold text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
          >
            100%
          </button>
        </div>
      </div>

      <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

      {/* Density */}
      <div className="px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-[0.1em] uppercase text-ink-muted/80">
          <Rows3 className="w-3 h-3" />
          <span>Density</span>
        </div>
        <p className="px-1 pt-1 pb-2 text-[11px] text-ink-muted/80 leading-snug">
          Row height, padding, and icon size in every layer column.
        </p>
        <div role="radiogroup" aria-label="Canvas density" className="grid grid-cols-3 gap-1.5">
          {DENSITY_OPTIONS.map(opt => {
            const active = canvasDensity === opt.mode
            const Icon = opt.icon
            return (
              <button
                key={opt.mode}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSetCanvasDensity(opt.mode)}
                title={opt.description}
                className={cn(
                  'flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-[11px] font-medium transition-colors',
                  active
                    ? 'bg-accent-lineage/15 border-accent-lineage/40 text-accent-lineage shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/35'
                    : 'bg-black/[0.02] border-transparent text-ink-muted hover:bg-black/[0.05] hover:border-black/[0.08] hover:text-ink dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
                )}
              >
                <Icon className="w-3.5 h-3.5" strokeWidth={2.2} />
                <span>{opt.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

      {/* Toggles */}
      <div className="px-3 pt-2.5 pb-3 space-y-1.5">
        <ToggleRow
          label="Show entity type badge"
          description={showTypeBadge ? 'Type label shown under each row' : 'Type label hidden'}
          icon={showTypeBadge ? Eye : EyeOff}
          active={showTypeBadge}
          onClick={onToggleTypeBadge}
          accent="cyan"
        />
        <ToggleRow
          label="Subtle tree lines"
          description={subtleTreeLines ? 'Connectors dimmed' : 'Connectors at full intensity'}
          icon={Rows3}
          active={subtleTreeLines}
          onClick={onToggleSubtleTreeLines}
          accent="purple"
        />
      </div>
    </>
  )
}

interface ToggleRowProps {
  label: string
  description: string
  icon: typeof Eye
  active: boolean
  onClick: () => void
  accent: 'cyan' | 'purple'
}

function ToggleRow({ label, description, icon: Icon, active, onClick, accent }: ToggleRowProps) {
  const activeBg = accent === 'cyan'
    ? 'bg-cyan-500/12 border-cyan-500/35 shadow-sm shadow-cyan-500/10 dark:bg-cyan-400/15 dark:border-cyan-400/30'
    : 'bg-purple-500/12 border-purple-500/35 shadow-sm shadow-purple-500/10 dark:bg-purple-400/15 dark:border-purple-400/30'
  const knobBg = accent === 'cyan' ? 'bg-cyan-500/85 dark:bg-cyan-400/80' : 'bg-purple-500/85 dark:bg-purple-400/80'
  const labelActiveColor = accent === 'cyan' ? 'text-cyan-700 dark:text-cyan-300' : 'text-purple-700 dark:text-purple-300'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
        active
          ? activeBg
          : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
          active ? knobBg : 'bg-ink-muted/25 dark:bg-white/15',
        )}
      >
        <div
          className={cn(
            'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
            active ? 'left-[15px]' : 'left-[2px]',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn(
          'text-[12px] font-medium leading-tight flex items-center gap-1.5',
          active ? labelActiveColor : 'text-ink',
        )}>
          <Icon className="w-3.5 h-3.5" strokeWidth={2.2} />
          <span>{label}</span>
        </div>
        <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">{description}</div>
      </div>
    </button>
  )
}
