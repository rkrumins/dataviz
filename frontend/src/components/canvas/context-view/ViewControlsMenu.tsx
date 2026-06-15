/**
 * ViewControlsMenu — the single "View" trigger for the canvas header.
 *
 * One calm gear that consolidates every display preference:
 *   · Audience    — Business ↔ Technical (label friendliness + level of detail)
 *   · Lineage     — edge density + direction (only when the mesh is on)
 *   · Canvas      — zoom, density, type badge, tree lines
 *   · Appearance  — theme (light/dark/system) + reduce motion
 *
 * Canvas-display settings are prop-driven (wired from ContextViewCanvas);
 * the global prefs (audience, theme, reduce motion) are read straight from
 * their stores, mirroring CanvasControls, to avoid deep prop drilling.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Accessibility,
  Briefcase,
  ChevronDown,
  Code2,
  Monitor,
  Moon,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sun,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CanvasDensity, LineageRenderMode, ThemeMode } from '@/store/preferences'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore, type PersonaMode } from '@/store/persona'
import { LineageDisplaySections } from './LineageDisplayPopover'
import { DisplaySettingsSections, isDisplaySettingsDefault } from './DisplaySettingsPopover'

const POPOVER_WIDTH = 320
const SEEN_KEY = 'synodic.viewMenu.seen.v1'

function readSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === '1' } catch { return true }
}
function markSeen(): void {
  try { localStorage.setItem(SEEN_KEY, '1') } catch { /* non-fatal */ }
}

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

  // First-run discoverability — pulse + coachmark until the user opens it once.
  const [showHint, setShowHint] = useState(false)
  useEffect(() => {
    if (!readSeen() && !open) setShowHint(true)
  }, [open])

  // Global prefs (read from stores; these affect the whole app)
  const personaMode = usePersonaStore((s) => s.mode)
  const setPersona = usePersonaStore((s) => s.setMode)
  const theme = usePreferencesStore((s) => s.theme)
  const setTheme = usePreferencesStore((s) => s.setTheme)
  const reduceMotion = usePreferencesStore((s) => s.reduceMotion)
  const toggleReduceMotion = usePreferencesStore((s) => s.toggleReduceMotion)

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

  const handleTriggerClick = () => {
    if (showHint) { setShowHint(false); markSeen() }
    setOpen(o => !o)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="View settings — audience, lineage, canvas display, and appearance"
        className={cn(
          'relative flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium transition-all duration-300',
          open || displayCustom
            ? 'bg-accent-lineage/15 border border-accent-lineage/35 text-ink shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/30'
            : 'bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]',
        )}
      >
        {/* First-run pulse ring */}
        {showHint && (
          <span className="absolute -inset-0.5 rounded-xl ring-2 ring-accent-lineage/50 animate-pulse pointer-events-none" />
        )}
        <SlidersHorizontal className="w-4 h-4" strokeWidth={2.2} />
        <span>View</span>
        {/* Customised indicator — a quiet accent dot when canvas display is off-default */}
        {displayCustom && !open && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent-lineage dark:shadow-[0_0_6px_rgba(99,102,241,0.7)]" />
        )}
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform duration-200', open && 'rotate-180')} />
      </button>

      {/* First-run coachmark */}
      {showHint && (
        <div className={cn(
          'absolute top-full right-0 mt-2 z-40 w-60 px-3 py-2 rounded-xl',
          'bg-canvas-elevated border border-accent-lineage/40 shadow-xl shadow-black/30',
          'text-[11px] text-ink leading-snug',
        )}>
          <span className="font-semibold text-accent-lineage">New — View settings.</span>{' '}
          Switch audience (Business / Technical), tune lineage &amp; canvas display, theme, and motion — all in one place.
          <span className="absolute -top-1.5 right-6 w-3 h-3 rotate-45 bg-canvas-elevated border-l border-t border-accent-lineage/40" />
        </div>
      )}

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
              className="rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-black/[0.10] dark:border-white/[0.08] shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden max-h-[min(620px,82vh)] overflow-y-auto"
            >
              {/* Title bar */}
              <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04] sticky top-0 bg-canvas-elevated/95 backdrop-blur-xl z-10">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
                  <Settings2 className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                </div>
                <div className="text-[12px] font-semibold text-ink tracking-tight">View Settings</div>
              </div>

              {/* Audience — the headline display control */}
              <SectionLabel>Audience</SectionLabel>
              <div className="px-3 pb-2">
                <p className="px-1 pb-2 text-[11px] text-ink-muted/80 leading-snug">
                  How entities are labelled and how much detail shows.
                </p>
                <Segmented<PersonaMode>
                  ariaLabel="Audience"
                  value={personaMode}
                  onChange={setPersona}
                  options={[
                    { value: 'business', label: 'Business', icon: Briefcase, description: 'Friendly names · domain-level detail', activeClass: 'bg-accent-business/15 border-accent-business/40 text-accent-business shadow-sm shadow-accent-business/10 dark:bg-accent-business/20 dark:border-accent-business/35' },
                    { value: 'technical', label: 'Technical', icon: Code2, description: 'Technical labels · asset-level detail', activeClass: 'bg-accent-technical/15 border-accent-technical/40 text-accent-technical shadow-sm shadow-accent-technical/10 dark:bg-accent-technical/20 dark:border-accent-technical/35' },
                  ]}
                />
              </div>

              <Divider />

              {/* Lineage section — only when the mesh is rendering */}
              {showLineageFlow && (
                <>
                  <SectionLabel>Lineage</SectionLabel>
                  <LineageDisplaySections
                    lineageRenderMode={lineageRenderMode}
                    onSetLineageRenderMode={onSetLineageRenderMode}
                    showEdgeDirection={showEdgeDirection}
                    onToggleEdgeDirection={onToggleEdgeDirection}
                  />
                  <Divider />
                </>
              )}

              {/* Canvas display section */}
              <div className="flex items-center justify-between pr-3">
                <SectionLabel>Canvas</SectionLabel>
                {displayCustom && (
                  <button
                    type="button"
                    onClick={onResetCanvasDisplaySettings}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                    title="Reset canvas display settings"
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
                showTypeBadge={showCanvasTypeBadge}
                onToggleTypeBadge={onToggleCanvasTypeBadge}
                subtleTreeLines={subtleCanvasTreeLines}
                onToggleSubtleTreeLines={onToggleSubtleCanvasTreeLines}
              />

              <Divider />

              {/* Appearance */}
              <SectionLabel>Appearance</SectionLabel>
              <div className="px-3 pb-3 space-y-2">
                <Segmented<ThemeMode>
                  ariaLabel="Theme"
                  value={theme}
                  onChange={setTheme}
                  options={[
                    { value: 'light', label: 'Light', icon: Sun, description: 'Always light' },
                    { value: 'dark', label: 'Dark', icon: Moon, description: 'Always dark' },
                    { value: 'system', label: 'System', icon: Monitor, description: 'Match your OS' },
                  ]}
                />
                <ReduceMotionToggle active={reduceMotion} onClick={toggleReduceMotion} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}

/* --- small building blocks --- */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pt-2.5 pb-1 text-[10px] font-bold tracking-[0.12em] uppercase text-accent-lineage/70">
      {children}
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-black/[0.10] dark:bg-white/[0.08] mx-3 my-1" />
}

interface SegOption<T extends string> {
  value: T
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  description?: string
  /** Active-state classes; defaults to the accent-lineage treatment. */
  activeClass?: string
}

const DEFAULT_ACTIVE =
  'bg-accent-lineage/15 border-accent-lineage/40 text-accent-lineage shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/35'

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: SegOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => {
        const active = value === opt.value
        const Icon = opt.icon
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            title={opt.description}
            className={cn(
              'flex flex-col items-center gap-1 px-2 py-2 rounded-lg border text-[11px] font-medium transition-colors',
              active
                ? (opt.activeClass ?? DEFAULT_ACTIVE)
                : 'bg-black/[0.02] border-transparent text-ink-muted hover:bg-black/[0.05] hover:border-black/[0.08] hover:text-ink dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
            )}
          >
            <Icon className="w-3.5 h-3.5" strokeWidth={2.2} />
            <span>{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function ReduceMotionToggle({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
        active
          ? 'bg-accent-lineage/12 border-accent-lineage/35 shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/30'
          : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
          active ? 'bg-accent-lineage/85' : 'bg-ink-muted/25 dark:bg-white/15',
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
          active ? 'text-accent-lineage' : 'text-ink',
        )}>
          <Accessibility className="w-3.5 h-3.5" strokeWidth={2.2} />
          <span>Reduce motion</span>
        </div>
        <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
          {active ? 'Animations minimised' : 'Animations enabled'}
        </div>
      </div>
    </button>
  )
}
