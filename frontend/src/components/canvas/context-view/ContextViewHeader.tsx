/**
 * ContextViewHeader - Layout shell for the Context View's toolbar.
 *
 * Receives all state as props from ContextViewCanvas — no store access here.
 * Keeps the orchestrator lean and makes the header independently testable.
 *
 * The header is partitioned by mode. Published is strictly read-only for
 * everybody; "edit mode" IS being on a draft (no separate flag):
 *   - View mode (default): comprehension tools + a calm Edit entry for
 *     managers (see header/ViewerActions.tsx).
 *   - Edit mode (on a draft): the same comprehension tools + the authoring
 *     cluster — Undo/Redo, Review & Save, Done (see header/EditorActions.tsx)
 *     — plus a thin amber strip along the top edge matching the
 *     CanvasVersioningBar's draft tint. Branch lifecycle (switcher /
 *     Publish / Discard) lives in that bar, never here.
 *
 * The header is INTENTIONALLY trace-agnostic. Trace UI lives in the
 * `TraceBottomDock` mounted inside ContextViewCanvas's canvas-body, in a
 * separate layout slot from the right-rail EntityDrawer.
 */

import { motion, AnimatePresence } from 'framer-motion'
import type { HierarchyNode } from './types'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { HeaderSearch, HeaderSearchResults } from './header/HeaderSearch'
import { ViewerActions } from './header/ViewerActions'
import { EditorActions } from './header/EditorActions'
import { ViewTitleMenu } from './header/ViewTitleMenu'

export interface ContextViewHeaderProps {
  // Search
  searchQuery: string
  onSearchChange: (q: string) => void
  searchResults: HierarchyNode[]
  onSearchResultClick: (node: HierarchyNode) => void

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
   *  surfaces this as a distinct "loading" button state with a toast on
   *  attempted click. */
  lineageReady: boolean

  // Trace depth — visible affordance under the Lineage controls so users
  // can see and adjust the current upstream/downstream hop count. Edits
  // re-run the active trace (handled by the parent's onSetTraceDepth).
  traceUpstreamDepth: number
  traceDownstreamDepth: number
  onSetTraceDepth: (dir: 'upstream' | 'downstream', value: number) => void

  // Mode — Published (View) vs. an open draft (Edit). `isDraft` picks the
  // right-hand cluster; `canManage`/`canEnterEdit` shape the Edit entry.
  isDraft: boolean
  canManage: boolean
  canEnterEdit: boolean
  onEnterEdit: () => void
  onExitEdit: () => void

  // Advanced search panel (G2 production UX surface).
  //
  // When invoked WITH a ``seedQuery`` (the current quick-search
  // value), the parent should:
  //   * clear the quick-search input so the no-match escalation
  //     card vanishes,
  //   * seed the Advanced Search panel's draft predicate with a
  //     ``TextPredicate{target:'name', value: seedQuery}`` so the
  //     user picks up where they left off without retyping.
  // When invoked WITHOUT a seedQuery, just toggle the panel.
  onOpenAdvancedSearch?: (seedQuery?: string) => void

  // Property Manager — opens the reusable right-side drawer for browsing
  // properties and authoring display-rule tags. Optional so canvases that
  // don't wire it simply omit the button.
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean

  // Title — actual view name + entity-type count, shown in the header.
  viewName?: string
  entityTypeCount?: number
  /** Folded into the title subline ({N} types · {model name}). */
  activeContextModelName: string | null

  // View-level capabilities + metadata actions. Independent of
  // isDraft/canManage — view metadata is not graph data, so the title menu
  // behaves identically on Published and drafts (see the header design spec).
  // With neither capability, the title stays a plain label (calm-view rule).
  canEditView?: boolean
  canShareView?: boolean
  viewVisibility?: 'private' | 'workspace' | 'enterprise'
  onRenameView?: (name: string) => void
  onEditViewDetails?: () => void
  onShareView?: () => void

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
}

export function ContextViewHeader({
  searchQuery,
  onSearchChange,
  searchResults,
  onSearchResultClick,
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
  isDraft,
  canManage,
  canEnterEdit,
  onEnterEdit,
  onExitEdit,
  onOpenAdvancedSearch,
  onTogglePropertyManager,
  propertyManagerOpen = false,
  viewName,
  entityTypeCount,
  activeContextModelName,
  canEditView = false,
  canShareView = false,
  viewVisibility,
  onRenameView,
  onEditViewDetails,
  onShareView,
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
    propertyManagerOpen,
    // Import / Export live in the shared cluster so the combined dropdown shows in BOTH modes; the
    // Import item self-disables when not editing (isDraft).
    onImport,
    onExport,
    isDraft,
  }

  const subline = [
    typeof entityTypeCount === 'number'
      ? `${entityTypeCount} type${entityTypeCount === 1 ? '' : 's'}`
      : null,
    activeContextModelName ?? 'Context View',
  ].filter(Boolean).join(' · ')

  return (
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
        {/* Zone 1 — Title. The whole title block (icon, name, subline with
            its sync spinner/retry) plus the view-metadata affordances (rename,
            Edit details, Share) live in ViewTitleMenu. The chevron/menu appear
            only when the user holds a view-level capability. */}
        <ViewTitleMenu
          viewName={viewName ?? 'Context View'}
          subline={subline}
          canEditView={canEditView}
          canShareView={canShareView}
          viewVisibility={viewVisibility}
          onRenameView={onRenameView}
          onEditViewDetails={onEditViewDetails}
          onShareView={onShareView}
          syncStatus={syncStatus}
          onRetrySync={onRetrySync}
        />

        {/* Zone 2 — Search. See header/HeaderSearch.tsx for the field +
            helper-row implementation. */}
        <HeaderSearch
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          onOpenAdvancedSearch={onOpenAdvancedSearch}
        />

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

      {/* Search Results — three states drive the row:
            1. query empty       → nothing rendered
            2. query + matches   → chip list + a tail "Search entire
                                   graph" escalation link
            3. query + no match  → prominent escalation card pointing
                                   the user at Advanced Search
          The escalation card makes the empty case the BEST moment to
          discover Advanced Search — exactly when the user has typed
          something and the visible canvas couldn't find it.
          See header/HeaderSearch.tsx for the implementation. */}
      <HeaderSearchResults
        searchQuery={searchQuery}
        searchResults={searchResults}
        onSearchResultClick={onSearchResultClick}
        onOpenAdvancedSearch={onOpenAdvancedSearch}
      />
    </div>
  )
}
