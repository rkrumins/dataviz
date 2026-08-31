/**
 * ContextViewHeader - Layout shell for the Context View's toolbar.
 *
 * Receives its state as props from ContextViewCanvas, which keeps the
 * orchestrator lean and the header independently testable. The one
 * exception is the search box, which reads the canvas's search session off
 * a context — a query, its results and its highlights are one thing shared
 * by three surfaces, and drilling it through here would only pass it on.
 *
 * The header is partitioned by mode. Published is strictly read-only for
 * everybody; "edit mode" IS being on a draft (no separate flag):
 *   - View mode (default): comprehension tools + a calm Edit entry for
 *     managers (see header/ViewerActions.tsx).
 *   - Edit mode (on a draft): the same comprehension tools + the authoring
 *     cluster — Undo/Redo, Review & Save, Done (see header/EditorActions.tsx)
 *     — plus a thin amber strip along the top edge matching the
 *     CanvasVersioningBar's draft tint. Publish / Discard stay in that bar.
 *
 * The left slot holds the BRANCH SWITCHER, not a title. It used to repeat the
 * view's name and type count, both of which the page header already prints
 * larger — one view, two names, three stacked bands. The name stayed upstairs
 * and the switcher came down into the slot it freed (see CanvasVersioningBar,
 * which now renders nothing at all in its idle Published state).
 *
 * The header is INTENTIONALLY trace-agnostic. Trace UI lives in the
 * `TraceBottomDock` mounted inside ContextViewCanvas's canvas-body, in a
 * separate layout slot from the right-rail EntityDrawer.
 */

import { motion, AnimatePresence } from 'framer-motion'
import { Loader2 } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { BranchSwitcher } from '@/features/versioning/components/BranchSwitcher'
import { HeaderSearch } from './header/HeaderSearch'
import { ViewerActions } from './header/ViewerActions'
import type { TraceHistoryPanelEntry } from './header/TraceHistoryPanel'
import { EditorActions } from './header/EditorActions'

export interface ContextViewHeaderProps {
  // Lineage flow
  showLineageFlow: boolean
  onToggleLineageFlow: () => void

  // Edge direction toggle
  showEdgeDirection: boolean
  onToggleEdgeDirection: () => void

  // Edge rendering mode — Stubs (chip-only) / Auto (size-adaptive) / Raw
  // (render all). Bound to usePreferencesStore.lineageRenderMode; the
  // canvas reads the same store separately. Header drives the user-
  // facing toggle; persistence + side effects live in the store.
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void

  // Trace — global toggle that mirrors the keyboard shortcut. Drawer's
  // per-node trace buttons remain for granular up/down/full control.
  traceActive: boolean
  canTrace: boolean
  onStartTrace: () => void
  onExitTrace: () => void
  /** True once the canvas finishes hydrating (entities + edges). When
   *  false, Trace is unsafe to fire — the backend hasn't fully loaded the
   *  lineage graph yet and the trace would return nothing. The header
   *  surfaces this as a distinct "loading" button state with a notification on
   *  attempted click. */
  lineageReady: boolean

  // Trace depth — visible affordance under the Lineage controls so users
  // can see and adjust the current upstream/downstream hop count. Edits
  // re-run the active trace (handled by the parent's onSetTraceDepth).
  traceUpstreamDepth: number
  traceDownstreamDepth: number
  onSetTraceDepth: (dir: 'upstream' | 'downstream', value: number) => void

  /** Trace trails in this view (newest first) — the "pick up where you
   *  left off" launcher under the Trace Lineage control. Optional. */
  traceHistory?: TraceHistoryPanelEntry[]
  onResumeTraceHistory?: (index: number) => void
  onClearTraceHistory?: () => void
  onCopyTraceHistoryLink?: (index: number) => string | null
  /** Open the Lineage Lens on the current selection. Optional. */
  onOpenLens?: () => void

  // Mode — Published (View) vs. an open draft (Edit). `isDraft` picks the
  // right-hand cluster; `canManage`/`canEnterEdit` shape the Edit entry.
  isDraft: boolean
  canManage: boolean
  canEnterEdit: boolean
  onEnterEdit: () => void
  onExitEdit: () => void

  // Property Manager — opens the reusable right-side drawer for browsing
  // properties and authoring display-rule tags. Optional so canvases that
  // don't wire it simply omit the button.
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean

  /** Branch switcher slot. The view's workspace when versioning chrome is
   *  available to this caller, `null` when it is not (flag off, read-only
   *  session, no workspace) — the switcher is then absent, exactly as the
   *  versioning bar was. The switcher hides itself when the data source has
   *  no versioned graph.
   *
   *  Only THIS canvas hosts it; the others keep it in CanvasVersioningBar,
   *  which is why that bar takes `showBranchSwitcher`. */
  branchWorkspaceId?: string | null
  branchDataSourceId?: string | null

  // Blueprint sync — surfaces only as a tiny subline spinner ('saving')
  // or a "Sync issue — retry" text button ('error' → onRetrySync).
  syncStatus: 'idle' | 'dirty' | 'saving' | 'synced' | 'error'
  onRetrySync?: () => void

  /** Number of staged changes pending review/save — drives Review & Save. */
  pendingChangeCount?: number
  /** Opens the staged-changes review panel (Review & Save click). */
  onOpenStagedChanges?: () => void
  /** Opens the bulk-import dialog (Edit mode). */
  onImport?: () => void
  /** Exports the graph to a downloadable file. */
  onExport?: () => void

  // Undo / Redo
  canUndo?: boolean
  canRedo?: boolean
  onUndo?: () => void
  onRedo?: () => void

  // Display settings — canvas zoom + density + chrome toggles
  canvasZoom: number
  onSetCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity
  onSetCanvasDensity: (density: CanvasDensity) => void
  showCanvasTypeBadge: boolean
  onToggleCanvasTypeBadge: () => void
  subtleCanvasTreeLines: boolean
  onToggleSubtleCanvasTreeLines: () => void
  onResetCanvasDisplaySettings: () => void
  /** Fit all layer columns into the viewport width (Cmd/Ctrl+0). */
  onFitToWidth?: () => void
}

export function ContextViewHeader({
  showLineageFlow,
  onToggleLineageFlow,
  showEdgeDirection,
  onToggleEdgeDirection,
  lineageRenderMode,
  onSetLineageRenderMode,
  traceActive,
  canTrace,
  onStartTrace,
  onExitTrace,
  lineageReady,
  traceUpstreamDepth,
  traceDownstreamDepth,
  onSetTraceDepth,
  traceHistory,
  onResumeTraceHistory,
  onClearTraceHistory,
  onCopyTraceHistoryLink,
  onOpenLens,
  isDraft,
  canManage,
  canEnterEdit,
  onEnterEdit,
  onExitEdit,
  onTogglePropertyManager,
  propertyManagerOpen = false,
  branchWorkspaceId,
  branchDataSourceId,
  syncStatus,
  onRetrySync,
  pendingChangeCount = 0,
  onOpenStagedChanges,
  onImport,
  onExport,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  canvasZoom,
  onSetCanvasZoom,
  canvasDensity,
  onSetCanvasDensity,
  showCanvasTypeBadge,
  onToggleCanvasTypeBadge,
  subtleCanvasTreeLines,
  onToggleSubtleCanvasTreeLines,
  onResetCanvasDisplaySettings,
  onFitToWidth,
}: ContextViewHeaderProps) {
  // Shared comprehension cluster — identical in both modes (see
  // header/ViewerActions.tsx for the rationale).
  const comprehensionProps = {
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
    onFitToWidth,
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
    traceHistory,
    onResumeTraceHistory,
    onClearTraceHistory,
    onCopyTraceHistoryLink,
    onOpenLens,
    onTogglePropertyManager,
    propertyManagerOpen,
    // Import / Export live in the shared cluster so the combined dropdown shows in BOTH modes; the
    // Import item self-disables when not editing (isDraft).
    onImport,
    onExport,
    isDraft,
  }

  return (
    /* A PLAIN token, not a gradient of alpha'd ones. The canvas colours are
       complete CSS variables, so `from-canvas-elevated/90` emits no rule and
       `--tw-gradient-stops` is never set — which makes the `background-image`
       invalid and paints NOTHING. This toolbar therefore had no fill at all:
       it sat directly under the page header, which uses the plain token and is
       solid, so one bar was opaque and the one below it was see-through, with
       its words floating over blurred canvas. */
    <div className="flex-shrink-0 bg-gradient-to-r from-canvas-elevated/90 via-canvas-elevated/95 to-canvas-elevated/90 backdrop-blur-xl border-b border-black/[0.08] dark:border-white/[0.06] px-6 py-3 relative">
      {/* Subtle gradient overlay — dark-mode decoration */}
      <div className="absolute inset-0 hidden dark:block bg-gradient-to-r from-accent-lineage/[0.02] via-transparent to-purple-500/[0.02] pointer-events-none" />

      {/* Draft-mode signal — a thin amber strip along the top edge, in the
          same amber family as the CanvasVersioningBar's draft tint. No
          "EDITING" pill and no draft name here: the bar above shows both. */}
      <AnimatePresence>
        {isDraft && (
          <motion.div
            key="draft-edge"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            aria-hidden
            className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-amber-500/50 via-amber-400 to-amber-500/50 pointer-events-none"
          />
        )}
      </AnimatePresence>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 relative">
        {/* Zone 1 — which version am I on, and did my layout save. The view's
            name, type count and metadata actions all live in the page header
            now; what is left here is the branch switcher (moved down out of
            CanvasVersioningBar) and the blueprint-sync signal that used to
            ride the title's subline. */}
        <div className="flex items-center gap-2 min-w-0">
          {branchWorkspaceId && (
            <BranchSwitcher
              workspaceId={branchWorkspaceId}
              dataSourceId={branchDataSourceId ?? null}
            />
          )}

          {/* A spinner and an error link, both unexplained: `aria-label` told a
              screen reader what was happening and a sighted user got an
              unlabelled glyph in the toolbar. */}
          {syncStatus === 'saving' && (
            <HoverTip
              className="inline-flex flex-shrink-0"
              label="Saving where things sit on the canvas"
              detail="Layout only — your entities and lineage are untouched"
            >
              <Loader2
                className="w-3.5 h-3.5 animate-spin text-ink-muted flex-shrink-0"
                aria-label="Saving changes"
              />
            </HoverTip>
          )}
          {syncStatus === 'error' && onRetrySync && (
            <HoverTip
              className="inline-flex flex-shrink-0"
              label="Try saving the canvas layout again"
              detail="The last save did not reach the server — nothing you did was lost"
            >
              <button
                onClick={onRetrySync}
                className="flex-shrink-0 text-[11px] font-semibold text-amber-600 dark:text-amber-400 hover:underline underline-offset-2 transition-colors"
              >
                Sync issue — retry
              </button>
            </HoverTip>
          )}
        </div>

        {/* Zone 2 — Search. Reads the canvas's search session off a
            context; see header/HeaderSearch.tsx. */}
        <HeaderSearch />

        {/* Zone 3 — Actions. Comprehension tools render identically in
            both modes; only the tail changes (Edit ↔ authoring cluster).
            Fast tween cross-fade — deliberately calm, no spring. */}
        <AnimatePresence mode="wait" initial={false}>
          {isDraft ? (
            <motion.div
              key="editor-actions"
              className="flex items-center gap-3"
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <EditorActions
                {...comprehensionProps}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={onUndo}
                onRedo={onRedo}
                pendingChangeCount={pendingChangeCount}
                onOpenStagedChanges={onOpenStagedChanges}
                onExitEdit={onExitEdit}
              />
            </motion.div>
          ) : (
            <motion.div
              key="viewer-actions"
              className="flex items-center gap-3"
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <ViewerActions
                {...comprehensionProps}
                canManage={canManage}
                canEnterEdit={canEnterEdit}
                onEnterEdit={onEnterEdit}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
