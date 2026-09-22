/**
 * LineageDisplayPopover — Lineage Settings popover for the Context View
 * toolbar. Houses two grouped sections:
 *
 *   1. Edge Density — Stubs / Auto / Raw rendering mode
 *   2. Direction   — arrow-marker toggle
 *
 * Visual identity mirrors `TraceDepthControl` so the two header chips
 * read as siblings: gradient-icon title bar, uppercase section labels
 * with icons, active states keyed off `accent-lineage`. The trigger
 * summarises the active configuration so the user doesn't need to open
 * the popover to read it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  ChevronDown,
  Eye,
  Layers,
  MoveRight,
  Settings2,
  Sliders,
  Sparkles,
  Unlink,
  Waves,
} from 'lucide-react'
import { useReducedMotionConfig } from 'framer-motion'
import { cn } from '@/lib/utils'
import { CollapsibleSection } from './DisplaySettingsPopover'
import { usePreferencesStore, type LineageMotion, type LineageRenderMode } from '@/store/preferences'
import { LINEAGE_DIRECTION_PRESETS, resolveLineageDirectionColors } from '@/lib/lineageDirectionColors'
import { PortLegend } from './LineageGuide'

interface LineageDisplayPopoverProps {
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void
  showEdgeDirection: boolean
  onToggleEdgeDirection: () => void
}

interface DensityOption {
  mode: LineageRenderMode
  label: string
  technical: string
  description: string
}

const DENSITY_OPTIONS: DensityOption[] = [
  {
    mode: 'stubs',
    label: 'On Hover',
    technical: 'Stubs',
    description: 'Edges appear when you hover or select a node',
  },
  {
    mode: 'auto',
    label: 'Adaptive',
    technical: 'Auto',
    description: 'Strongest flows stay visible on dense graphs; markers summarize the rest — hover or select to focus',
  },
  {
    mode: 'raw',
    label: 'All Edges',
    technical: 'Raw',
    description: 'Render every projected edge (heavy on dense workspaces)',
  },
]

const MODE_SHORT_LABEL: Record<LineageRenderMode, string> = {
  stubs: 'Stubs',
  auto: 'Auto',
  raw: 'Raw',
}

const POPOVER_WIDTH = 320

export function LineageDisplayPopover({
  lineageRenderMode,
  onSetLineageRenderMode,
  showEdgeDirection,
  onToggleEdgeDirection,
}: LineageDisplayPopoverProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Compute popover position from the trigger's viewport rect. Re-runs on
  // open/resize/scroll so the popover stays anchored if the page reflows.
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
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Lineage settings — edge density and direction arrows"
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium transition-all duration-300',
          open
            ? 'bg-accent-lineage/15 border border-accent-lineage/35 text-ink shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/30'
            : 'bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]',
        )}
      >
        <Sliders className="w-3.5 h-3.5" />
        <span className="flex items-center gap-1 tabular-nums">
          <Eye className="w-3 h-3 text-accent-lineage/80 dark:text-accent-lineage" strokeWidth={2.4} />
          <span className="text-accent-lineage font-semibold">{MODE_SHORT_LABEL[lineageRenderMode]}</span>
          <span className="opacity-30 mx-0.5">·</span>
          <MoveRight
            className={cn(
              'w-3 h-3',
              showEdgeDirection ? 'text-cyan-500 dark:text-cyan-400' : 'text-ink-muted/40 dark:text-white/25',
            )}
            strokeWidth={2.4}
          />
        </span>
        <ChevronDown
          className={cn('w-3 h-3 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

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
              transition={{ duration: 0.15, ease: 'easeOut' }}
              role="dialog"
              aria-label="Lineage settings"
              style={{
                position: 'fixed',
                top: anchor.top,
                right: anchor.right,
                width: POPOVER_WIDTH,
                zIndex: 1000,
              }}
              className="rounded-xl bg-canvas-elevated/95 backdrop-blur-xl border border-glass-border shadow-2xl shadow-black/20 dark:shadow-black/40 overflow-hidden"
            >
              {/* Title bar — mirrors TraceDepthControl's header so the two
                  popovers read as a matched pair. */}
              <div className="px-3 pt-3 pb-1 flex items-center gap-2 border-b border-black/[0.06] dark:border-white/[0.04]">
                <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-accent-lineage/25 to-purple-500/15 flex items-center justify-center">
                  <Settings2 className="w-3.5 h-3.5 text-accent-lineage" strokeWidth={2.2} />
                </div>
                <div className="text-[12px] font-semibold text-ink tracking-tight">Lineage Settings</div>
              </div>

              <LineageDisplaySections
                lineageRenderMode={lineageRenderMode}
                onSetLineageRenderMode={onSetLineageRenderMode}
                showEdgeDirection={showEdgeDirection}
                onToggleEdgeDirection={onToggleEdgeDirection}
              />
            </motion.div>
          )}
        </>,
        document.body,
      )}
    </>
  )
}

interface LineageDisplaySectionsProps {
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void
  showEdgeDirection: boolean
  onToggleEdgeDirection: () => void
  /** When true, every control renders inert (native `disabled`) and muted —
   *  used by the header's DisplayMenu when Lineage is off. */
  disabled?: boolean
}

/**
 * LineageDisplaySections — the Edge Density / Direction body shared by the
 * standalone LineageDisplayPopover and the header's consolidated
 * DisplayMenu. Pure content, no trigger/shell/title-bar of its own.
 */
export function LineageDisplaySections({
  lineageRenderMode,
  onSetLineageRenderMode,
  showEdgeDirection,
  onToggleEdgeDirection,
  disabled = false,
}: LineageDisplaySectionsProps) {
  return (
    <div className={cn(disabled && 'opacity-50')}>
      {/* Edge Density */}
      <CollapsibleSection
        id="edge-density"
        icon={Layers}
        title="Edge Density"
        summary={DENSITY_OPTIONS.find(o => o.mode === lineageRenderMode)?.label ?? 'Adaptive'}
      >
        <p className="px-1 pt-1 pb-2 text-[11px] text-ink-muted/80 leading-snug">
          How many edges materialise on the canvas at once.
        </p>
        <div
          role="radiogroup"
          aria-label="Edge density"
          className="flex flex-col gap-1"
        >
          {DENSITY_OPTIONS.map(opt => {
            const active = lineageRenderMode === opt.mode
            return (
              <button
                key={opt.mode}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => onSetLineageRenderMode(opt.mode)}
                className={cn(
                  'flex items-start gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors',
                  disabled && 'cursor-not-allowed',
                  active
                    ? 'bg-accent-lineage/15 border-accent-lineage/40 shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/35'
                    : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors',
                    active ? 'border-accent-lineage' : 'border-ink-muted/40',
                  )}
                >
                  {active && (
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-lineage" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'text-[12px] font-medium leading-tight flex items-baseline gap-1.5',
                      active ? 'text-accent-lineage' : 'text-ink',
                    )}
                  >
                    <span>{opt.label}</span>
                    <span className="text-[10px] text-ink-muted/60 font-normal">
                      ({opt.technical})
                    </span>
                  </div>
                  <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
                    {opt.description}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
        {lineageRenderMode === 'auto' && <AdaptiveBudgetSlider disabled={disabled} />}
        {lineageRenderMode === 'auto' && <FlowRibbonsToggle disabled={disabled} />}
      </CollapsibleSection>

      <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

      <AppearanceSection disabled={disabled} />

      <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

      {/* Direction */}
      <CollapsibleSection
        id="edge-direction"
        icon={MoveRight}
        title="Direction"
        summary={showEdgeDirection ? 'On' : 'Off'}
      >
        <p className="px-1 pt-1 pb-2 text-[11px] text-ink-muted/80 leading-snug">
          Show arrow markers on edges to indicate flow direction.
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={showEdgeDirection}
          disabled={disabled}
          onClick={onToggleEdgeDirection}
          className={cn(
            'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
            disabled && 'cursor-not-allowed',
            showEdgeDirection
              ? 'bg-cyan-500/12 border-cyan-500/35 shadow-sm shadow-cyan-500/10 dark:bg-cyan-400/15 dark:border-cyan-400/30'
              : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
          )}
        >
          <div
            className={cn(
              'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
              showEdgeDirection
                ? 'bg-cyan-500/85 dark:bg-cyan-400/80'
                : 'bg-ink-muted/25 dark:bg-white/15',
            )}
          >
            <div
              className={cn(
                'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
                showEdgeDirection ? 'left-[15px]' : 'left-[2px]',
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                'text-[12px] font-medium leading-tight flex items-center gap-1.5',
                showEdgeDirection ? 'text-cyan-700 dark:text-cyan-300' : 'text-ink',
              )}
            >
              <MoveRight className="w-3.5 h-3.5" strokeWidth={2.2} />
              <span>Arrow markers</span>
            </div>
            <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
              {showEdgeDirection ? 'Currently visible' : 'Currently hidden'}
            </div>
          </div>
        </button>
      </CollapsibleSection>

      <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

      {/* Missing connections — Views are subsets of a Data Source, so a
          curated view legitimately excludes upstream/downstream partners.
          This switch shows/hides the "connections not on canvas" alerts. */}
      <MissingConnectionsToggle disabled={disabled} />

      <div className="h-px bg-black/[0.08] dark:bg-white/[0.06] mx-3" />

      <ExternalPreviewToggle disabled={disabled} />
    </div>
  )
}

const MOTION_OPTIONS: Array<{ motion: LineageMotion; label: string; description: string }> = [
  {
    motion: 'focus',
    label: 'When focused',
    description: 'Lines move for what you hover, select or trace. The rest stay still.',
  },
  {
    motion: 'all',
    label: 'Always',
    description: 'Every line moves while 200 or fewer are drawn; past that, only focused ones.',
  },
  {
    motion: 'off',
    label: 'Off',
    description: 'No line moves.',
  },
]

/** How lines move and how cards sit over them — lineMotion.ts, and
 *  `.nx-row-card` in globals.css. Self-contained store access, like the
 *  toggles below. */
function AppearanceSection({ disabled }: { disabled: boolean }) {
  const motion = usePreferencesStore((s) => s.lineageMotion) ?? 'focus'
  const setMotion = usePreferencesStore((s) => s.setLineageMotion)
  const frosted = usePreferencesStore((s) => s.frostedCards) ?? false
  const toggleFrosted = usePreferencesStore((s) => s.toggleFrostedCards)
  const trays = usePreferencesStore((s) => s.showConnectedTrays) ?? true
  const toggleTrays = usePreferencesStore((s) => s.toggleConnectedTrays)
  // Calm mode, or the system's reduce-motion setting — either stills every line.
  const reduced = useReducedMotionConfig() ?? false
  const motionLabel = MOTION_OPTIONS.find(o => o.motion === motion)?.label ?? 'When focused'
  return (
    <CollapsibleSection
      id="lineage-appearance"
      icon={Sparkles}
      title="Appearance"
      summary={`${reduced ? 'Still' : motionLabel} · ${frosted ? 'Frosted' : 'Solid'}`}
    >
      <p className="px-1 pt-1 pb-2 text-[11px] text-ink-muted leading-snug">
        Which lines move, and whether lines show through entity cards.
      </p>
      <div role="radiogroup" aria-label="Line motion" className="flex flex-col gap-1">
        {MOTION_OPTIONS.map(opt => {
          const active = motion === opt.motion
          return (
            <button
              key={opt.motion}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => setMotion(opt.motion)}
              className={cn(
                'flex items-start gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors',
                disabled && 'cursor-not-allowed',
                active
                  ? 'bg-accent-lineage/15 border-accent-lineage/40 shadow-sm shadow-accent-lineage/10 dark:bg-accent-lineage/20 dark:border-accent-lineage/35'
                  : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
              )}
            >
              <div
                className={cn(
                  'mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors',
                  active && 'border-accent-lineage',
                )}
              >
                {active && <div className="w-1.5 h-1.5 rounded-full bg-accent-lineage" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn('text-[12px] font-medium leading-tight', active ? 'text-accent-lineage' : 'text-ink')}>
                  {opt.label}
                </div>
                <div className="text-[11px] text-ink-muted leading-snug mt-0.5">{opt.description}</div>
              </div>
            </button>
          )
        })}
      </div>
      {reduced && (
        <p className="px-1 pt-1.5 text-[11px] text-ink-muted leading-snug">
          Reduce motion is on (calm mode or your system setting), so no line moves.
        </p>
      )}
      <DirectionColors disabled={disabled} />
      <button
        type="button"
        role="switch"
        aria-checked={frosted}
        disabled={disabled}
        onClick={toggleFrosted}
        className={cn(
          'mt-2 w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
          disabled && 'cursor-not-allowed',
          frosted
            ? 'bg-accent-lineage/[0.12] border-accent-lineage/35 shadow-sm shadow-accent-lineage/10'
            : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
        )}
      >
        <div
          className={cn(
            'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
            frosted ? 'bg-accent-lineage/85' : 'bg-black/15 dark:bg-white/15',
          )}
        >
          <div
            className={cn(
              'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
              frosted ? 'left-[15px]' : 'left-[2px]',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn('text-[12px] font-medium leading-tight', frosted ? 'text-accent-lineage' : 'text-ink')}>
            Frosted cards
          </div>
          <div className="text-[11px] text-ink-muted leading-snug mt-0.5">
            {frosted
              ? 'Lines show softly through cards. Heavier to draw on large views.'
              : 'Off — lines pass cleanly under cards'}
          </div>
        </div>
      </button>
      <SwitchRow
        on={trays}
        disabled={disabled}
        onToggle={toggleTrays}
        label="Connected above & below"
        detail={trays
          ? 'Lists the selected entity\'s partners scrolled out of each column'
          : 'A small hint instead — click it for the list'}
      />
    </CollapsibleSection>
  )
}

/** A labelled on/off switch in the Appearance section's own style. */
function SwitchRow({ on, disabled, onToggle, label, detail }: {
  on: boolean
  disabled: boolean
  onToggle: () => void
  label: string
  detail: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'mt-2 w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
        disabled && 'cursor-not-allowed',
        on
          ? 'bg-accent-lineage/[0.12] border-accent-lineage/35 shadow-sm shadow-accent-lineage/10'
          : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
          on ? 'bg-accent-lineage/85' : 'bg-black/15 dark:bg-white/15',
        )}
      >
        <div
          className={cn(
            'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
            on ? 'left-[15px]' : 'left-[2px]',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn('text-[12px] font-medium leading-tight', on ? 'text-accent-lineage' : 'text-ink')}>{label}</div>
        <div className="text-[11px] text-ink-muted leading-snug mt-0.5">{detail}</div>
      </div>
    </button>
  )
}

/** The product's lineage DIRECTION pair — incoming / outgoing on every
 *  surface (lib/lineageDirectionColors.ts): presets, or the reader's own. */
function DirectionColors({ disabled }: { disabled: boolean }) {
  const stored = usePreferencesStore((s) => s.lineageDirectionColors)
  const setColors = usePreferencesStore((s) => s.setLineageDirectionColors)
  const colors = resolveLineageDirectionColors(stored)
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  return (
    <div className="mt-3 px-2.5 py-2.5 rounded-lg bg-black/[0.02] dark:bg-white/[0.02] border border-black/[0.06] dark:border-white/[0.05]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-ink">Lineage colours</span>
        <PortLegend />
      </div>
      <p className="pt-1 pb-2 text-[11px] text-ink-muted leading-snug">
        Incoming and outgoing lineage, the same everywhere — the ports on each
        card, the entity panel, the Focus Lens and traces.
      </p>
      <div role="radiogroup" aria-label="Lineage colours" className="grid grid-cols-2 gap-1">
        {LINEAGE_DIRECTION_PRESETS.map(preset => {
          const active = same(preset.in, colors.in) && same(preset.out, colors.out)
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => setColors({ in: preset.in, out: preset.out })}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-lg border text-left text-[11.5px] transition-colors',
                disabled && 'cursor-not-allowed',
                active
                  ? 'bg-accent-lineage/15 border-accent-lineage/40 text-ink'
                  : 'border-transparent text-ink-muted hover:bg-black/[0.05] hover:text-ink dark:hover:bg-white/[0.05]',
              )}
            >
              <span className="flex items-center gap-0.5 flex-shrink-0" aria-hidden>
                <span className="w-1.5 h-3.5 rounded-full" style={{ backgroundColor: preset.in }} />
                <span className="w-1.5 h-3.5 rounded-full" style={{ backgroundColor: preset.out }} />
              </span>
              <span className="truncate">{preset.label}</span>
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-4 px-1">
        {(['in', 'out'] as const).map(dir => (
          <label key={dir} className={cn('flex items-center gap-2 text-[11px] text-ink-muted', !disabled && 'cursor-pointer')}>
            <span
              className="relative w-5 h-5 rounded-md border border-black/10 dark:border-white/15 overflow-hidden"
              style={{ backgroundColor: colors[dir] }}
            >
              <input
                type="color"
                value={colors[dir]}
                disabled={disabled}
                onChange={(e) => setColors({ ...colors, [dir]: e.target.value })}
                aria-label={dir === 'in' ? 'Incoming lineage colour' : 'Outgoing lineage colour'}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
              />
            </span>
            {dir === 'in' ? 'Incoming' : 'Outgoing'}
          </label>
        ))}
      </div>
    </div>
  )
}

/** Feature flag for the out-of-view lineage PREVIEW — the guided
 *  click-through from the "outside this view" chip into the Lens.
 *  Self-contained store access, mirroring MissingConnectionsToggle. */
function ExternalPreviewToggle({ disabled }: { disabled: boolean }) {
  const on = usePreferencesStore((s) => s.externalLineagePreview)
  const toggle = usePreferencesStore((s) => s.toggleExternalLineagePreview)
  return (
    <div className="px-3 pt-2.5 pb-3">
      <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-[0.1em] uppercase text-ink-muted/80">
        <Eye className="w-3 h-3" />
        <span>External Preview</span>
      </div>
      <p className="px-1 pt-1 pb-2 text-[11px] text-ink-muted/80 leading-snug">
        Adds a Preview action when a selected entity has lineage outside
        this view — see those partners in the Lens without adding
        anything to the canvas.
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
          disabled && 'cursor-not-allowed',
          on
            ? 'bg-sky-500/12 border-sky-500/35 shadow-sm shadow-sky-500/10 dark:bg-sky-400/15 dark:border-sky-400/30'
            : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
        )}
      >
        <div
          className={cn(
            'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
            on ? 'bg-sky-500/85 dark:bg-sky-400/80' : 'bg-ink-muted/25 dark:bg-white/15',
          )}
        >
          <div
            className={cn(
              'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
              on ? 'left-[15px]' : 'left-[2px]',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium leading-tight text-ink">Preview outside-view lineage</div>
          <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
            {on ? 'On — chip offers Preview' : 'Off'}
          </div>
        </div>
      </button>
    </div>
  )
}

const BUDGET_MIN = 100
const BUDGET_MAX = 2000
const BUDGET_STEP = 50

/** Adaptive edge budget — how many of the strongest flows render at once
 *  above the threshold (and the size of a focused node's materialized
 *  fan). Reads/writes the persisted preference directly, mirroring the
 *  self-contained MissingConnectionsToggle pattern. */
function AdaptiveBudgetSlider({ disabled }: { disabled: boolean }) {
  const budget = usePreferencesStore((s) => s.autoStubThreshold)
  const setBudget = usePreferencesStore((s) => s.setAutoStubThreshold)
  const clamped = Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, budget ?? 500))
  return (
    <div className="mt-2 px-2.5 py-2 rounded-lg bg-black/[0.02] dark:bg-white/[0.02] border border-black/[0.06] dark:border-white/[0.05]">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.1em] uppercase text-ink-muted/80">
        <Sliders className="w-3 h-3" />
        <span>Edge Budget</span>
        <span className="ml-auto tabular-nums text-accent-lineage/80">{clamped.toLocaleString()}</span>
      </div>
      <p className="pt-1 pb-1.5 text-[11px] text-ink-muted/80 leading-snug">
        How many of the strongest flows stay visible at once on dense
        graphs. Markers summarize the rest.
      </p>
      <input
        type="range"
        min={BUDGET_MIN}
        max={BUDGET_MAX}
        step={BUDGET_STEP}
        value={clamped}
        disabled={disabled}
        onChange={(e) => setBudget(parseInt(e.target.value, 10))}
        className="w-full accent-accent-lineage"
        aria-label="Adaptive edge budget"
      />
      <div className="flex justify-between text-[9.5px] text-ink-muted/60 tabular-nums">
        <span>{BUDGET_MIN} · calm</span>
        <span>{BUDGET_MAX.toLocaleString()} · detailed</span>
      </div>
    </div>
  )
}

/** Flow ribbons on/off — Sankey-style macro volume bands between layer
 *  columns while Adaptive is summarizing. Self-contained store access,
 *  mirroring MissingConnectionsToggle. */
function FlowRibbonsToggle({ disabled }: { disabled: boolean }) {
  const show = usePreferencesStore((s) => s.showFlowRibbons) ?? false
  const toggle = usePreferencesStore((s) => s.toggleFlowRibbons)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={show}
      disabled={disabled}
      onClick={toggle}
      className={cn(
        'mt-2 w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
        disabled && 'cursor-not-allowed',
        show
          ? 'bg-accent-lineage/12 border-accent-lineage/35 shadow-sm shadow-accent-lineage/10'
          : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
      )}
    >
      <div
        className={cn(
          'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
          show ? 'bg-accent-lineage/85' : 'bg-ink-muted/25 dark:bg-white/15',
        )}
      >
        <div
          className={cn(
            'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
            show ? 'left-[15px]' : 'left-[2px]',
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-[12px] font-medium leading-tight flex items-center gap-1.5',
            show ? 'text-accent-lineage' : 'text-ink',
          )}
        >
          <Waves className="w-3.5 h-3.5" strokeWidth={2.2} />
          <span>Flow ribbons</span>
        </div>
        <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
          Layer-to-layer volume bands (Sankey-style) when flows exceed
          the edge budget. A band can cross the layers between its two ends.
        </div>
        <div
          className={cn(
            'text-[10.5px] font-semibold leading-snug mt-1',
            show ? 'text-accent-lineage' : 'text-ink-muted/60',
          )}
        >
          {show
            ? 'On — bands appear once edges are summarized'
            : 'Off'}
        </div>
      </div>
    </button>
  )
}

function MissingConnectionsToggle({ disabled }: { disabled: boolean }) {
  const show = usePreferencesStore((s) => s.showMissingConnectionIndicators)
  const toggle = usePreferencesStore((s) => s.toggleMissingConnectionIndicators)
  return (
    <div className="px-3 pt-2.5 pb-3">
      <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold tracking-[0.1em] uppercase text-ink-muted/80">
        <Unlink className="w-3 h-3" />
        <span>Missing Connections</span>
      </div>
      <p className="px-1 pt-1 pb-2 text-[11px] text-ink-muted/80 leading-snug">
        Alert when links reference entities outside this view. Views are
        subsets — hide this if out-of-view partners are expected.
      </p>
      <button
        type="button"
        role="switch"
        aria-checked={show}
        disabled={disabled}
        onClick={toggle}
        className={cn(
          'w-full flex items-center gap-3 px-2.5 py-2 rounded-lg border text-left transition-colors',
          disabled && 'cursor-not-allowed',
          show
            ? 'bg-amber-500/12 border-amber-500/35 shadow-sm shadow-amber-500/10 dark:bg-amber-400/15 dark:border-amber-400/30'
            : 'bg-black/[0.02] border-transparent hover:bg-black/[0.05] hover:border-black/[0.08] dark:bg-white/[0.02] dark:hover:bg-white/[0.05] dark:hover:border-white/[0.06]',
        )}
      >
        <div
          className={cn(
            'flex-shrink-0 w-[32px] h-[18px] rounded-full relative transition-colors duration-200',
            show ? 'bg-amber-500/85 dark:bg-amber-400/80' : 'bg-ink-muted/25 dark:bg-white/15',
          )}
        >
          <div
            className={cn(
              'absolute top-[2px] w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-all duration-200',
              show ? 'left-[15px]' : 'left-[2px]',
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              'text-[12px] font-medium leading-tight flex items-center gap-1.5',
              show ? 'text-amber-700 dark:text-amber-300' : 'text-ink',
            )}
          >
            <Unlink className="w-3.5 h-3.5" strokeWidth={2.2} />
            <span>Missing-link alerts</span>
          </div>
          <div className="text-[11px] text-ink-muted/80 leading-snug mt-0.5">
            {show ? 'Currently visible' : 'Currently hidden'}
          </div>
        </div>
      </button>
    </div>
  )
}
