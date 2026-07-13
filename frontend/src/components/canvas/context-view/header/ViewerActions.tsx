/**
 * ViewerActions — the Context View header's right cluster in View mode
 * (Published, the default for everyone).
 *
 * Layout: [Lineage ●] [Display ▾] [Trace] [Properties] │ [Edit]
 *
 * Also home to `ComprehensionTools`, the mode-independent cluster shared
 * with EditorActions: the comprehension tools (Lineage toggle, Display
 * menu, Trace, Property Manager) are IDENTICAL in both modes — entering
 * edit must never take understanding away — so both clusters render the
 * same component rather than maintaining two copies.
 *
 * The Edit entry is the ONLY mutation affordance on Published, and only
 * for holders of `workspace:datasource:manage` (viewers see nothing —
 * confirmed product decision, not even a disabled hint). Clicking it
 * opens/resumes a draft; being on a draft IS edit mode.
 */

import { motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'
import { useToast } from '@/components/ui/toast'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { TraceDepthControl } from '../TraceDepthControl'
import { PropertyManagerButton } from '../../property-manager/PropertyManagerButton'
import { DisplayMenu } from './DisplayMenu'
import { ImportExportMenu } from './ImportExportMenu'

export interface ComprehensionToolsProps {
  // Lineage flow
  showLineageFlow: boolean
  onToggleLineageFlow: () => void

  // Display menu — canvas zoom/density/badges + lineage appearance
  canvasZoom: number
  onSetCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity
  onSetCanvasDensity: (density: CanvasDensity) => void
  showCanvasTypeBadge: boolean
  onToggleCanvasTypeBadge: () => void
  subtleCanvasTreeLines: boolean
  onToggleSubtleCanvasTreeLines: () => void
  onResetCanvasDisplaySettings: () => void
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void
  showEdgeDirection: boolean
  onToggleEdgeDirection: () => void

  // Trace — global toggle that mirrors the keyboard shortcut. Drawer's
  // per-node trace buttons remain for granular up/down/full control.
  traceActive: boolean
  canTrace: boolean
  onStartTrace: () => void
  onExitTrace: () => void
  /** True once the canvas finishes hydrating (entities + edges). When
   *  false, Trace is unsafe to fire — the backend hasn't fully loaded the
   *  lineage graph yet and the trace would return nothing. Surfaced as a
   *  distinct "loading" button state with a toast on attempted click. */
  lineageReady: boolean
  traceUpstreamDepth: number
  traceDownstreamDepth: number
  onSetTraceDepth: (dir: 'upstream' | 'downstream', value: number) => void

  // Property Manager — optional so canvases that don't wire it omit the button.
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean

  // Import / Export — one combined dropdown, shown in BOTH modes (Export is always reachable). The
  // Import item disables with an explainer when not editing (`isDraft` false), since import writes to
  // the working draft.
  onImport?: () => void
  onExport?: () => void
  isDraft: boolean
}

export function ComprehensionTools({
  showLineageFlow,
  onToggleLineageFlow,
  canvasZoom,
  onSetCanvasZoom,
  canvasDensity,
  onSetCanvasDensity,
  showCanvasTypeBadge,
  onToggleCanvasTypeBadge,
  subtleCanvasTreeLines,
  onToggleSubtleCanvasTreeLines,
  onResetCanvasDisplaySettings,
  lineageRenderMode,
  onSetLineageRenderMode,
  showEdgeDirection,
  onToggleEdgeDirection,
  traceActive,
  canTrace,
  onStartTrace,
  onExitTrace,
  lineageReady,
  traceUpstreamDepth,
  traceDownstreamDepth,
  onSetTraceDepth,
  onTogglePropertyManager,
  propertyManagerOpen = false,
  onImport,
  onExport,
  isDraft,
}: ComprehensionToolsProps) {
  const { showToast } = useToast()

  // Warn the user when they try to trace before the lineage data has
  // finished hydrating. Keyed so rapid repeat clicks coalesce instead of
  // stacking dozens of identical toasts.
  const warnLineageNotReady = () => {
    showToast(
      'warning',
      'Trace is unavailable until lineage finishes loading. Please wait a moment.',
    )
  }

  return (
    <>
      {/* Lineage Flow Toggle — single stable label. State is conveyed
          through the colored dot + active gradient. Trace state lives
          on its own button below; this label no longer encodes it. */}
      <button
        onClick={onToggleLineageFlow}
        title={showLineageFlow ? 'Hide the lineage mesh on the canvas' : 'Show the lineage mesh on the canvas'}
        className={cn(
          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300",
          showLineageFlow
            ? "bg-gradient-to-r from-accent-lineage/15 to-accent-lineage/[0.08] text-accent-lineage shadow-sm shadow-accent-lineage/10 border border-accent-lineage/35 dark:from-accent-lineage/20 dark:to-accent-lineage/10 dark:shadow-lg dark:shadow-accent-lineage/20 dark:border-accent-lineage/30"
            : "bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]"
        )}
      >
        <motion.div animate={{ rotate: showLineageFlow ? 0 : -180 }} transition={{ duration: 0.3 }}>
          <LucideIcons.GitBranch className="w-4 h-4" />
        </motion.div>
        <span>Lineage</span>
        <div className={cn(
          "w-2 h-2 rounded-full transition-colors duration-300",
          showLineageFlow ? "bg-green-500 dark:bg-green-400 dark:shadow-lg dark:shadow-green-400/50" : "bg-ink-muted/30"
        )} />
      </button>

      {/* Display menu — consolidates canvas display settings (zoom,
          density, type-badge, subtle lines) and lineage appearance
          (edge density, direction arrows) behind a single trigger.
          Always visible: the Lineage-appearance section renders
          muted/disabled (rather than being hidden) when Lineage is
          off, so users can discover it exists. */}
      <DisplayMenu
        canvasZoom={canvasZoom}
        onSetCanvasZoom={onSetCanvasZoom}
        canvasDensity={canvasDensity}
        onSetCanvasDensity={onSetCanvasDensity}
        showTypeBadge={showCanvasTypeBadge}
        onToggleTypeBadge={onToggleCanvasTypeBadge}
        subtleTreeLines={subtleCanvasTreeLines}
        onToggleSubtleTreeLines={onToggleSubtleCanvasTreeLines}
        onReset={onResetCanvasDisplaySettings}
        lineageRenderMode={lineageRenderMode}
        onSetLineageRenderMode={onSetLineageRenderMode}
        showEdgeDirection={showEdgeDirection}
        onToggleEdgeDirection={onToggleEdgeDirection}
        lineageEnabled={showLineageFlow}
      />

      {/* Trace toggle — three visual states:
          1. `traceActive` → Exit Trace (rose, pulsing dot)
          2. `!lineageReady` → "Loading lineage…" (indigo pulse + spinner).
             Stays clickable to fire a warning toast, so the affordance
             reads as "not yet" rather than "broken".
          3. ready → Trace Lineage (existing indigo gradient). Hard-
             disabled when no entity selected. */}
      {traceActive ? (
        <button
          onClick={onExitTrace}
          title="Exit trace mode"
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-rose-500/20 to-rose-500/10 text-rose-700 border border-rose-400/50 hover:from-rose-500/30 hover:to-rose-500/20 hover:border-rose-400/70 dark:text-rose-200 dark:border-rose-400/40 dark:hover:border-rose-300/60 dark:hover:shadow-lg dark:hover:shadow-rose-500/20 transition-all duration-300"
        >
          <LucideIcons.X className="w-4 h-4" strokeWidth={2.4} />
          <span>Exit Trace</span>
          <span className="w-2 h-2 rounded-full bg-rose-500 dark:bg-rose-300 dark:shadow-lg dark:shadow-rose-300/60 animate-pulse" />
        </button>
      ) : !lineageReady ? (
        <button
          onClick={warnLineageNotReady}
          aria-busy="true"
          title="Lineage data is still loading — Trace will become available once it finishes"
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300 cursor-wait",
            "bg-gradient-to-r from-accent-lineage/12 to-purple-500/[0.06] text-accent-lineage/85 border border-accent-lineage/30",
            "dark:from-accent-lineage/18 dark:to-purple-500/10 dark:text-accent-lineage dark:border-accent-lineage/25",
            "shadow-sm shadow-accent-lineage/10",
          )}
        >
          <LucideIcons.Loader2 className="w-4 h-4 animate-spin" strokeWidth={2.4} />
          <span>Loading lineage…</span>
          <span
            className="w-2 h-2 rounded-full bg-accent-lineage dark:shadow-lg dark:shadow-accent-lineage/60 animate-pulse"
            aria-hidden
          />
        </button>
      ) : (
        <button
          onClick={canTrace ? onStartTrace : undefined}
          disabled={!canTrace}
          title={canTrace ? 'Trace lineage of selected entity' : 'Select a single entity to trace its lineage'}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300",
            canTrace
              ? "bg-gradient-to-r from-accent-lineage/20 to-purple-500/10 text-accent-lineage border border-accent-lineage/40 hover:from-accent-lineage/30 hover:to-purple-500/20 hover:border-accent-lineage/60 dark:hover:shadow-lg dark:hover:shadow-accent-lineage/20"
              : "bg-black/[0.03] border border-black/[0.06] text-ink-muted/50 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-ink-muted/40 cursor-not-allowed"
          )}
        >
          <LucideIcons.Workflow className="w-4 h-4" strokeWidth={2.2} />
          <span>Trace Lineage</span>
        </button>
      )}

      {/* Trace Depth — visible only during an active trace. Sits right
          next to the Trace toggle so the active scope (↑N upstream,
          ↓N downstream) is one glance away. Blue / green colors
          mirror EntityDrawer's Root Cause / Impact treatment. */}
      {traceActive && (
        <TraceDepthControl
          upstreamDepth={traceUpstreamDepth}
          downstreamDepth={traceDownstreamDepth}
          onChange={onSetTraceDepth}
        />
      )}

      {/* Property Manager — opens the right-side drawer to browse
          properties and roll out display-rule tags onto matched
          entities. Shared button carries the first-run coachmark so
          the affordance is consistent across all canvases. */}
      {onTogglePropertyManager && (
        <PropertyManagerButton
          open={propertyManagerOpen}
          onToggle={onTogglePropertyManager}
        />
      )}

      {/* Import / Export — one dropdown, both modes. Import is disabled with an explainer outside
          Edit mode; Export is always available (published state is a valid, re-importable backup). */}
      <ImportExportMenu onImport={onImport} onExport={onExport} isDraft={isDraft} />
    </>
  )
}

export interface ViewerActionsProps extends ComprehensionToolsProps {
  /** Holder of `workspace:datasource:manage` — the Edit entry renders only for them. */
  canManage: boolean
  /** False until the data source's versioned graph resolves — Edit disables with a hint. */
  canEnterEdit: boolean
  onEnterEdit: () => void
}

export function ViewerActions({ canManage, canEnterEdit, onEnterEdit, ...tools }: ViewerActionsProps) {
  // Editing IS versioning (edit mode = an open draft): when the admin turns
  // versioning off, the Edit entry disappears entirely — not disabled-with-hint.
  const versioningEnabled = useFeature('versioningEnabled')
  return (
    <>
      <ComprehensionTools {...tools} />

      {/* Edit — accent-bordered but calm (deliberately NOT a filled
          primary: on Published, reading is the main activity and the
          header should stay quiet). Clicking opens/resumes a draft;
          the amber versioning bar + header morph are the feedback. */}
      {canManage && versioningEnabled && (
        <>
          <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />
          <button
            onClick={canEnterEdit ? onEnterEdit : undefined}
            disabled={!canEnterEdit}
            title={canEnterEdit
              ? 'Make changes in a private draft — the published version stays untouched'
              : "Version control isn't set up for this data source yet"}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300",
              canEnterEdit
                ? "bg-accent-lineage/[0.08] text-accent-lineage border border-accent-lineage/45 shadow-sm shadow-accent-lineage/10 hover:bg-accent-lineage/[0.14] hover:border-accent-lineage/65 dark:bg-accent-lineage/[0.12] dark:border-accent-lineage/40 dark:hover:shadow-lg dark:hover:shadow-accent-lineage/15"
                : "bg-black/[0.03] border border-black/[0.06] text-ink-muted/50 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-ink-muted/40 cursor-not-allowed"
            )}
          >
            <LucideIcons.PenLine className="w-4 h-4" strokeWidth={2.2} />
            <span>Edit</span>
          </button>
        </>
      )}
    </>
  )
}
