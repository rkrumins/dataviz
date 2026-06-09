/**
 * ContextViewHeader - Toolbar, search, and authoring controls for Context View.
 *
 * Receives all state as props from ContextViewCanvas — no store access here.
 * Keeps the orchestrator lean and makes the header independently testable.
 *
 * The header is INTENTIONALLY trace-agnostic. Trace UI lives in the
 * `TraceBottomDock` mounted inside ContextViewCanvas's canvas-body, in a
 * separate layout slot from the right-rail EntityDrawer. The header here
 * is purely about authoring + display-mode controls.
 */

import { useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import type { HierarchyNode } from './types'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { LineageDisplayPopover } from './LineageDisplayPopover'
import { DisplaySettingsPopover } from './DisplaySettingsPopover'
import { TraceDepthControl } from './TraceDepthControl'
import { PropertyManagerButton } from '../property-manager/PropertyManagerButton'

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

  // Add entity
  onAddEntity: () => void

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
  advancedSearchOpen?: boolean

  // Property Manager — opens the reusable right-side drawer for browsing
  // properties and authoring display-rule tags. Optional so canvases that
  // don't wire it simply omit the button.
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean

  // Title — actual view name + entity-type count, shown in the header.
  // Replaces the previous hardcoded "Context View / Data Flow Blueprint".
  viewName?: string
  entityTypeCount?: number

  // Blueprint
  activeWorkspaceId: string | null
  activeContextModelName: string | null
  syncStatus: 'idle' | 'dirty' | 'saving' | 'synced' | 'error'
  onSave: () => void
  /** Number of staged changes pending review/save — drives the badge + label. */
  pendingChangeCount?: number
  /** Optional click handler for the staged-changes badge (opens review panel). */
  onOpenStagedChanges?: () => void

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
  onAddEntity,
  onOpenAdvancedSearch,
  advancedSearchOpen = false,
  onTogglePropertyManager,
  propertyManagerOpen = false,
  viewName,
  entityTypeCount,
  activeWorkspaceId,
  activeContextModelName,
  syncStatus,
  onSave,
  pendingChangeCount = 0,
  onOpenStagedChanges,
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
  const searchInputRef = useRef<HTMLInputElement>(null)
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
    <div className="flex-shrink-0 bg-gradient-to-r from-canvas-elevated/90 via-canvas-elevated/95 to-canvas-elevated/90 backdrop-blur-xl border-b border-black/[0.08] dark:border-white/[0.06] px-6 py-3 relative">
      {/* Subtle gradient overlay — dark-mode decoration */}
      <div className="absolute inset-0 hidden dark:block bg-gradient-to-r from-accent-lineage/[0.02] via-transparent to-purple-500/[0.02] pointer-events-none" />

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 relative min-w-0">
        {/* Title */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-lineage/20 to-purple-500/20 flex items-center justify-center shadow-lg shadow-accent-lineage/10">
            <LucideIcons.Network className="w-5 h-5 text-accent-lineage" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-display font-semibold text-ink tracking-tight truncate" title={viewName ?? 'Context View'}>
              {viewName ?? 'Context View'}
            </h2>
            <p className="text-[10px] text-ink-muted/70 flex items-center gap-1.5">
              <LucideIcons.ArrowRight className="w-3 h-3" />
              {typeof entityTypeCount === 'number'
                ? `${entityTypeCount} type${entityTypeCount === 1 ? '' : 's'} · Context View`
                : 'Context View'}
            </p>
          </div>
        </div>

        {/* Zone 2 — Search.
            Quick search filters the VISIBLE entities (the flat tree
            currently rendered on the canvas) by name + type. Below
            the input we surface a one-line scope hint with an
            inline escalation link to Advanced Search so the user
            always knows the difference at a glance:
              · Quick    = name/type match across visible nodes
              · Advanced = predicate-tree search across the entire
                          graph at any depth (lineage / containment /
                          tag / property / paths / aggregations).
            Visual treatment (premium uplift):
              · Glass-morphism backdrop with gradient
              · Focus state lifts shadow + accent ring (not just border)
              · Eye-pill scope indicator AND a kbd hint when idle
              · Subtle inner ring on hover for "this is interactive" */}
        <div className="justify-self-center w-full max-w-md min-w-0">
          <div className="relative group">
            {/* Accent halo on focus — soft glow behind the input that
                lifts it off the header gradient. Pure decoration; sits
                behind the input via negative inset. */}
            <div
              aria-hidden
              className={cn(
                "absolute -inset-px rounded-[14px] pointer-events-none",
                "bg-gradient-to-r from-accent-lineage/0 via-accent-lineage/0 to-purple-500/0",
                "group-focus-within:from-accent-lineage/20 group-focus-within:via-accent-lineage/10 group-focus-within:to-purple-500/15",
                "group-focus-within:blur-[8px]",
                "transition-all duration-300",
              )}
            />
            <LucideIcons.Search
              className={cn(
                "absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] pointer-events-none",
                "text-ink-muted/55 group-focus-within:text-accent-lineage",
                "group-hover:text-ink-muted/80",
                "transition-colors duration-200",
              )}
              strokeWidth={2.2}
            />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search visible entities…"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              aria-label="Search visible entities by name or type"
              className={cn(
                "relative w-full pl-10 pr-32 py-2.5 rounded-[13px]",
                "text-[13.5px] text-ink placeholder:text-ink-muted/45",
                // Layered fill: subtle gradient + glass border so the
                // field reads like a deliberate component, not a
                // default text input.
                "bg-gradient-to-b from-black/[0.03] to-black/[0.05]",
                "dark:from-white/[0.04] dark:to-white/[0.025]",
                "border border-black/[0.08] dark:border-white/[0.08]",
                "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
                // Hover: brighten the inner ring.
                "hover:border-black/[0.14] dark:hover:border-white/[0.14]",
                // Focus: accent ring + lift shadow. Not a system blue
                // outline.
                "focus:outline-none",
                "focus:border-accent-lineage/55 focus:ring-2 focus:ring-accent-lineage/20",
                "focus:shadow-[0_4px_18px_-6px_rgba(99,102,241,0.35)]",
                "focus:bg-gradient-to-b focus:from-black/[0.045] focus:to-black/[0.06]",
                "dark:focus:from-white/[0.06] dark:focus:to-white/[0.045]",
                "transition-all duration-200",
              )}
            />
            {/* Right-side affordance cluster.
                Idle: a sparkles button that opens Advanced Search
                (scans the entire graph at any depth) + a separator
                + a passive "Visible" scope label so the user
                understands the default quick-search scope.
                Typed: a clear (X) button on the left of the
                advanced trigger so the user can wipe and retry
                without losing the escalation affordance. */}
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {searchQuery && (
                <button
                  onClick={() => onSearchChange('')}
                  aria-label="Clear search"
                  className={cn(
                    "p-1 rounded-md transition-all",
                    "text-ink-muted/70 hover:text-ink",
                    "hover:bg-black/[0.06] dark:hover:bg-white/[0.08]",
                  )}
                >
                  <LucideIcons.X className="w-3.5 h-3.5" strokeWidth={2.4} />
                </button>
              )}
              {!searchQuery && (
                <span
                  title="Quick search scans the entities currently visible on this canvas."
                  className={cn(
                    "hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md",
                    "text-[10px] font-semibold uppercase tracking-wider",
                    "text-ink-muted/70",
                    "bg-gradient-to-b from-black/[0.04] to-black/[0.06]",
                    "dark:from-white/[0.05] dark:to-white/[0.03]",
                    "border border-black/[0.06] dark:border-white/[0.06]",
                    "shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]",
                  )}
                >
                  <LucideIcons.Eye className="w-2.5 h-2.5" strokeWidth={2.4} />
                  Visible
                </span>
              )}
              {onOpenAdvancedSearch && (
                <button
                  onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
                  aria-label={searchQuery.trim()
                    ? `Search "${searchQuery.trim()}" across the entire graph with Advanced Search`
                    : 'Open Advanced Search — scan the entire graph'}
                  title={searchQuery.trim()
                    ? `Search "${searchQuery.trim()}" across the entire graph`
                    : 'Open Advanced Search · scan the entire graph at any depth'}
                  className={cn(
                    'inline-flex items-center justify-center w-7 h-7 rounded-lg',
                    'transition-all duration-200',
                    'text-accent-lineage',
                    'bg-gradient-to-br from-accent-lineage/15 to-purple-500/10',
                    'border border-accent-lineage/30',
                    'hover:from-accent-lineage/25 hover:to-purple-500/20',
                    'hover:border-accent-lineage/55 hover:shadow-md hover:shadow-accent-lineage/20',
                    'active:scale-95',
                  )}
                >
                  <LucideIcons.Sparkles className="w-3.5 h-3.5" strokeWidth={2.4} />
                </button>
              )}
            </div>
          </div>
          {/* Inline helper / escalation row — always visible so users
              learn the boundary between quick and advanced search.
              Compresses to icon-only on narrower viewports via the
              hidden md:inline classes. When the user already typed
              something, the escalation link seeds the Advanced panel
              with that text so they don't retype. */}
          {onOpenAdvancedSearch && (
            <div className="mt-1.5 px-1 flex items-center justify-between gap-2 text-[10.5px] leading-none">
              <span className="text-ink-muted/65 truncate">
                <LucideIcons.Layers
                  className="inline-block w-2.5 h-2.5 mr-1 -mt-0.5 opacity-70"
                  strokeWidth={2.2}
                />
                <span className="hidden md:inline">Searching visible entities only. </span>
                <span className="md:hidden">Visible only. </span>
                <button
                  onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
                  className={cn(
                    "font-semibold text-accent-lineage",
                    "hover:text-accent-lineage hover:underline",
                    "underline-offset-[3px] decoration-accent-lineage/40 hover:decoration-accent-lineage/80",
                    "transition-colors",
                  )}
                >
                  {searchQuery.trim()
                    ? `Search "${searchQuery.trim()}" across entire graph →`
                    : 'Search the entire graph →'}
                </button>
              </span>
            </div>
          )}
        </div>

        {/* Zone 3 — Actions. Wraps (never clips) when space is tight: the search collapses
            first (min-w-0 above), then these wrap to a second line, right-aligned, so the
            Save / Pending buttons are always visible and clickable. */}
        <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
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

          {/* Display popover — consolidates Edge Density (Stubs/Auto/Raw)
              and Direction arrows behind a single trigger. Hidden when
              Lineage is off: with no mesh rendering, these settings have
              no effect, so the toolbar stays uncluttered. */}
          {showLineageFlow && (
            <LineageDisplayPopover
              lineageRenderMode={lineageRenderMode}
              onSetLineageRenderMode={onSetLineageRenderMode}
              showEdgeDirection={showEdgeDirection}
              onToggleEdgeDirection={onToggleEdgeDirection}
            />
          )}

          {/* Canvas display settings — zoom, density, type-badge, subtle lines.
              Always visible: these affect node rendering, not edges, so they
              stay useful even when the lineage mesh is off. */}
          <DisplaySettingsPopover
            canvasZoom={canvasZoom}
            onSetCanvasZoom={onSetCanvasZoom}
            canvasDensity={canvasDensity}
            onSetCanvasDensity={onSetCanvasDensity}
            showTypeBadge={showCanvasTypeBadge}
            onToggleTypeBadge={onToggleCanvasTypeBadge}
            subtleTreeLines={subtleCanvasTreeLines}
            onToggleSubtleTreeLines={onToggleSubtleCanvasTreeLines}
            onReset={onResetCanvasDisplaySettings}
          />

          <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

          {/* Advanced Search — opens SearchMapPanel for the deep
              predicate-tree surface. Unlike the quick search above
              (visible-nodes only), this scans the entire graph at
              any depth: tags, properties, paths, lineage gaps,
              aggregations. Treated as a tier-1 action so it gets a
              filled accent background, not a ghost button, making
              the value proposition obvious before the user clicks. */}
          {onOpenAdvancedSearch && (
            <button
              onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
              title="Scan the entire graph — predicate filters, lineage paths, aggregations, drill-down. Works at any depth."
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-300",
                advancedSearchOpen
                  ? "bg-gradient-to-r from-accent-lineage/30 to-purple-500/20 text-accent-lineage border border-accent-lineage/60 shadow-md shadow-accent-lineage/20 dark:shadow-lg dark:shadow-accent-lineage/30"
                  : "bg-gradient-to-r from-accent-lineage/15 to-purple-500/10 text-accent-lineage border border-accent-lineage/35 hover:from-accent-lineage/25 hover:to-purple-500/15 hover:border-accent-lineage/55 hover:shadow-md hover:shadow-accent-lineage/15 dark:from-accent-lineage/20 dark:to-purple-500/15"
              )}
            >
              <LucideIcons.Sparkles className="w-4 h-4" strokeWidth={2.4} />
              <span>Advanced Search</span>
            </button>
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

          <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

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

          <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

          {/* Add Entity */}
          <button
            onClick={onAddEntity}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-green-500/15 to-emerald-500/[0.08] text-green-700 border border-green-500/40 hover:from-green-500/25 hover:to-emerald-500/15 hover:border-green-500/60 dark:from-green-500/20 dark:to-emerald-500/10 dark:text-green-400 dark:border-green-500/30 dark:hover:shadow-lg dark:hover:shadow-green-500/20 transition-all duration-300"
          >
            <LucideIcons.Plus className="w-4 h-4" />
            <span>Add Entity</span>
          </button>

          <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

          {/* Blueprint indicator */}
          {activeContextModelName && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-purple-500/[0.08] border border-purple-500/25 dark:border-purple-500/20"
              title={activeContextModelName}
            >
              <LucideIcons.BookMarked className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 flex-shrink-0" />
              <span className="text-xs font-medium text-purple-700 dark:text-purple-300 truncate max-w-[140px]">
                {activeContextModelName}
              </span>
            </div>
          )}

          {/* Undo/Redo */}
          {(canUndo || canRedo) && (
            <div className="flex items-stretch rounded-xl overflow-hidden shrink-0 bg-black/[0.03] dark:bg-gradient-to-b dark:from-white/[0.06] dark:to-white/[0.02] border border-black/[0.10] dark:border-white/[0.08]">
              <button
                onClick={onUndo}
                disabled={!canUndo}
                title="Undo last change (⌘Z)"
                aria-label="Undo"
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-[11.5px] font-semibold tracking-tight transition-all",
                  canUndo
                    ? "text-ink/85 hover:bg-black/[0.06] hover:text-ink active:bg-black/[0.10] dark:hover:bg-white/[0.06] dark:active:bg-white/[0.10]"
                    : "text-ink-muted/40 dark:text-ink-muted/25 cursor-not-allowed"
                )}
              >
                <LucideIcons.Undo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
                <span>Undo</span>
              </button>
              <div className="w-px bg-black/[0.10] dark:bg-white/[0.08]" />
              <button
                onClick={onRedo}
                disabled={!canRedo}
                title="Redo (⌘⇧Z)"
                aria-label="Redo"
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 text-[11.5px] font-semibold tracking-tight transition-all",
                  canRedo
                    ? "text-ink/85 hover:bg-black/[0.06] hover:text-ink active:bg-black/[0.10] dark:hover:bg-white/[0.06] dark:active:bg-white/[0.10]"
                    : "text-ink-muted/40 dark:text-ink-muted/25 cursor-not-allowed"
                )}
              >
                <span>Redo</span>
                <LucideIcons.Redo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
              </button>
            </div>
          )}

          {/* Pending changes */}
          {pendingChangeCount > 0 && onOpenStagedChanges && (
            <button
              onClick={onOpenStagedChanges}
              title="Review pending changes"
              className="relative flex items-center gap-2 pl-2.5 pr-3 py-2 rounded-xl shrink-0 whitespace-nowrap bg-gradient-to-br from-amber-300/25 via-amber-400/20 to-orange-500/15 border border-amber-400/60 text-amber-800 hover:from-amber-300/35 hover:to-orange-500/25 hover:border-amber-400/80 transition-all shadow-sm shadow-amber-500/15 hover:shadow-md hover:shadow-amber-500/20 dark:text-amber-100 dark:border-amber-300/50 dark:hover:border-amber-200/70 dark:hover:shadow-lg dark:hover:shadow-amber-500/25"
            >
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 dark:bg-amber-300 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-500 dark:bg-amber-300 ring-2 ring-canvas-elevated" />
              </span>
              <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-amber-200 border border-amber-300 dark:bg-amber-300/25 dark:border-amber-200/40">
                <LucideIcons.ListChecks className="w-3.5 h-3.5 text-amber-800 dark:text-amber-100" strokeWidth={2.4} />
              </span>
              <span className="text-[12px] font-bold tabular-nums leading-none">{pendingChangeCount}</span>
              <span className="text-[10.5px] uppercase tracking-[0.08em] font-bold leading-none">Pending</span>
            </button>
          )}

          {/* Save */}
          <button
            onClick={onSave}
            disabled={(syncStatus !== 'dirty' && syncStatus !== 'error' && pendingChangeCount === 0) || !activeWorkspaceId}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300 shrink-0 whitespace-nowrap",
              (syncStatus === 'dirty' || pendingChangeCount > 0)
                ? "bg-gradient-to-r from-blue-500/15 to-cyan-500/[0.08] text-blue-700 border border-blue-500/40 hover:from-blue-500/25 hover:to-cyan-500/15 hover:border-blue-500/60 dark:from-blue-500/20 dark:to-cyan-500/10 dark:text-blue-400 dark:border-blue-500/30 dark:hover:shadow-lg dark:hover:shadow-blue-500/20"
                : syncStatus === 'error'
                  ? "bg-gradient-to-r from-red-500/15 to-red-500/[0.08] text-red-700 border border-red-500/40 dark:from-red-500/20 dark:to-red-500/10 dark:text-red-400 dark:border-red-500/30"
                  : "bg-black/[0.03] border border-black/[0.06] text-ink-muted/50 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-ink-muted/50 cursor-not-allowed"
            )}
            title={
              !activeWorkspaceId ? 'No workspace selected'
                : pendingChangeCount > 0 ? `Apply ${pendingChangeCount} pending change${pendingChangeCount === 1 ? '' : 's'} and save`
                : syncStatus === 'dirty' ? 'Save changes to backend'
                  : syncStatus === 'error' ? 'Save failed — click to retry'
                    : 'All changes saved'
            }
          >
            {syncStatus === 'saving'
              ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
              : syncStatus === 'error'
                ? <LucideIcons.AlertCircle className="w-4 h-4" />
                : syncStatus === 'synced' && pendingChangeCount === 0
                  ? <LucideIcons.CheckCircle className="w-4 h-4" />
                  : <LucideIcons.Save className="w-4 h-4" />
            }
            <span>
              {syncStatus === 'saving' ? 'Saving...'
                : syncStatus === 'error' ? 'Retry Save'
                  : pendingChangeCount > 0 ? `Save ${pendingChangeCount} change${pendingChangeCount === 1 ? '' : 's'}`
                  : syncStatus === 'synced' ? 'Saved'
                    : 'Save Blueprint'}
            </span>
            {(syncStatus === 'dirty' || pendingChangeCount > 0) && (
              <div className="w-2 h-2 rounded-full bg-blue-500 dark:bg-blue-400 dark:shadow-lg dark:shadow-blue-400/50" />
            )}
          </button>
        </div>
      </div>

      {/* Search Results — three states drive the row:
            1. query empty       → nothing rendered
            2. query + matches   → chip list + a tail "Search entire
                                   graph" escalation link
            3. query + no match  → prominent escalation card pointing
                                   the user at Advanced Search
          The escalation card makes the empty case the BEST moment to
          discover Advanced Search — exactly when the user has typed
          something and the visible canvas couldn't find it. */}
      <AnimatePresence>
        {searchQuery.trim().length > 0 && searchResults.length === 0 && (
          <motion.div
            key="no-results-escalation"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3"
          >
            <div className={cn(
              "flex items-center gap-3 px-3.5 py-2.5 rounded-xl",
              "border-l-4 border-l-accent-lineage border border-accent-lineage/40",
              "bg-accent-lineage/[0.10] dark:bg-accent-lineage/[0.12]",
              "shadow-[0_0_18px_-6px_rgba(99,102,241,0.35)]",
            )}>
              <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-accent-lineage/20 border border-accent-lineage/40">
                <LucideIcons.SearchX className="w-4 h-4 text-accent-lineage" strokeWidth={2.4} />
              </div>
              <div className="flex-1 min-w-0 text-[12px] leading-snug">
                <div className="font-display font-semibold text-ink">
                  No match in visible entities
                </div>
                <div className="text-ink-muted">
                  &ldquo;{searchQuery}&rdquo; isn&rsquo;t on the canvas right now.
                  Advanced Search scans the entire graph — across
                  every depth, every entity type, every lineage path.
                </div>
              </div>
              {onOpenAdvancedSearch && (
                <button
                  onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg",
                    "bg-accent-lineage text-white text-[12px] font-semibold",
                    "shadow-lg shadow-accent-lineage/30",
                    "hover:bg-accent-lineage/90 hover:shadow-accent-lineage/40",
                    "transition-all active:scale-[0.98]",
                  )}
                >
                  <LucideIcons.Sparkles className="w-3.5 h-3.5" strokeWidth={2.4} />
                  Advanced Search
                  <LucideIcons.ArrowRight className="w-3 h-3" strokeWidth={2.4} />
                </button>
              )}
            </div>
          </motion.div>
        )}
        {searchResults.length > 0 && (
          <motion.div
            key="results-chips"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 flex items-center gap-2 flex-wrap relative"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <LucideIcons.Search className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-xs font-medium text-amber-600 dark:text-amber-300">
                {searchResults.length} in visible
              </span>
            </div>
            {searchResults.slice(0, 5).map((node, idx) => (
              <motion.button
                key={node.id}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: idx * 0.05 }}
                onClick={() => onSearchResultClick(node)}
                className="px-3 py-1.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.04] border border-black/[0.10] dark:border-white/[0.08] text-ink text-xs font-medium hover:bg-accent-lineage/15 hover:border-accent-lineage/40 hover:text-accent-lineage transition-all duration-200 hover:shadow-md hover:shadow-black/5 dark:hover:shadow-lg dark:hover:shadow-accent-lineage/10"
              >
                {node.name}
              </motion.button>
            ))}
            {searchResults.length > 5 && (
              <span className="px-2 py-1 text-xs text-ink-muted/60">+{searchResults.length - 5} more</span>
            )}
            {/* Tail escalation: "Search the entire graph for X" link.
                Keeps quick search as the default but makes the
                Advanced upgrade discoverable inline. Seeds the
                Advanced panel with the current query so the user
                doesn't retype. */}
            {onOpenAdvancedSearch && (
              <button
                onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
                title="Open Advanced Search — scans the full graph at any depth"
                className={cn(
                  "ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl",
                  "text-xs font-medium",
                  "bg-accent-lineage/10 text-accent-lineage",
                  "border border-accent-lineage/30 hover:border-accent-lineage/60",
                  "hover:bg-accent-lineage/20 transition-all",
                )}
              >
                <LucideIcons.Sparkles className="w-3 h-3" strokeWidth={2.4} />
                Search entire graph
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

