/**
 * ContextViewHeader - Toolbar, search, and authoring controls for Context View.
 *
 * Receives all state as props from ContextViewCanvas — no store access here.
 * Keeps the orchestrator lean and makes the header independently testable.
 *
 * The header is mode-aware. Zone 3 swaps between two partitions of the same
 * props depending on `isEditing`:
 *   · Explore (default) — view-only controls for business users (ExploreActions)
 *   · Edit  (opt-in)    — authoring + commit controls (EditActions)
 * Search (Zone 2) and Title (Zone 1) are identical in both modes — search stays
 * central. The header is INTENTIONALLY trace-agnostic for the bottom dock; trace
 * UI there lives in `TraceBottomDock` inside ContextViewCanvas's canvas-body.
 */

import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HierarchyNode } from './types'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { ToolbarSearch } from './ToolbarSearch'
import { ViewControls } from './ViewControls'
import { ExploreActions } from './ExploreActions'
import { EditActions } from './EditActions'

export interface ContextViewHeaderProps {
  // Mode — Explore (read-only) ↔ Edit (authoring). Default Explore.
  isEditing: boolean
  onEnterEdit: () => void
  /** Returns to Explore. The parent applies the unsaved-changes guard. */
  onExitEdit: () => void

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

  // Edge rendering mode — Stubs / Auto / Raw. Bound to
  // usePreferencesStore.lineageRenderMode.
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void

  // Trace
  traceActive: boolean
  canTrace: boolean
  onStartTrace: () => void
  onExitTrace: () => void
  /** True once the canvas finishes hydrating (entities + edges). */
  lineageReady: boolean
  traceUpstreamDepth: number
  traceDownstreamDepth: number
  onSetTraceDepth: (dir: 'upstream' | 'downstream', value: number) => void

  // Add entity
  onAddEntity: () => void

  // Advanced search panel — opens the deep predicate surface, optionally seeded.
  onOpenAdvancedSearch?: (seedQuery?: string) => void

  // Property Manager — browse properties + author display-rule tags.
  onTogglePropertyManager?: () => void
  propertyManagerOpen?: boolean

  // Title
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
  isEditing,
  onEnterEdit,
  onExitEdit,
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
  return (
    <div className="flex-shrink-0 bg-gradient-to-r from-canvas-elevated/90 via-canvas-elevated/95 to-canvas-elevated/90 backdrop-blur-xl border-b border-black/[0.08] dark:border-white/[0.06] px-6 py-3 relative">
      {/* Subtle gradient overlay — dark-mode decoration */}
      <div className="absolute inset-0 hidden dark:block bg-gradient-to-r from-accent-lineage/[0.02] via-transparent to-purple-500/[0.02] pointer-events-none" />

      {/* Edit-mode accent strip — a clear, layout-stable signal of the mode. */}
      <AnimatePresence>
        {isEditing && (
          <motion.div
            key="edit-strip"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-amber-400/0 via-amber-400/70 to-amber-400/0 pointer-events-none"
          />
        )}
      </AnimatePresence>

      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-4 relative">
        {/* Zone 1 — Title */}
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

        {/* Zone 2 — Search (scope-aware, identical in both modes) */}
        <ToolbarSearch
          searchQuery={searchQuery}
          onSearchChange={onSearchChange}
          onOpenAdvancedSearch={onOpenAdvancedSearch}
        />

        {/* Zone 3 — always-visible view controls + mode-partitioned actions */}
        <div className="justify-self-end flex items-center gap-3">
          {/* Visibility cluster — shown in both Explore and Edit so users can
              adjust what's on the canvas without leaving their current mode. */}
          <ViewControls
            showLineageFlow={showLineageFlow}
            onToggleLineageFlow={onToggleLineageFlow}
            showEdgeDirection={showEdgeDirection}
            onToggleEdgeDirection={onToggleEdgeDirection}
            lineageRenderMode={lineageRenderMode}
            onSetLineageRenderMode={onSetLineageRenderMode}
            canvasZoom={canvasZoom}
            onSetCanvasZoom={onSetCanvasZoom}
            canvasDensity={canvasDensity}
            onSetCanvasDensity={onSetCanvasDensity}
            showCanvasTypeBadge={showCanvasTypeBadge}
            onToggleCanvasTypeBadge={onToggleCanvasTypeBadge}
            subtleCanvasTreeLines={subtleCanvasTreeLines}
            onToggleSubtleCanvasTreeLines={onToggleSubtleCanvasTreeLines}
            onResetCanvasDisplaySettings={onResetCanvasDisplaySettings}
          />

          <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />

          <AnimatePresence mode="wait" initial={false}>
            {isEditing ? (
              <motion.div
                key="edit-actions"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <EditActions
                  onExitEdit={onExitEdit}
                  onAddEntity={onAddEntity}
                  onTogglePropertyManager={onTogglePropertyManager}
                  propertyManagerOpen={propertyManagerOpen}
                  canUndo={canUndo}
                  canRedo={canRedo}
                  onUndo={onUndo}
                  onRedo={onRedo}
                  pendingChangeCount={pendingChangeCount}
                  onOpenStagedChanges={onOpenStagedChanges}
                  activeWorkspaceId={activeWorkspaceId}
                  syncStatus={syncStatus}
                  onSave={onSave}
                />
              </motion.div>
            ) : (
              <motion.div
                key="explore-actions"
                initial={{ opacity: 0, x: 8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                <ExploreActions
                  traceActive={traceActive}
                  canTrace={canTrace}
                  onStartTrace={onStartTrace}
                  onExitTrace={onExitTrace}
                  lineageReady={lineageReady}
                  traceUpstreamDepth={traceUpstreamDepth}
                  traceDownstreamDepth={traceDownstreamDepth}
                  onSetTraceDepth={onSetTraceDepth}
                  onTogglePropertyManager={onTogglePropertyManager}
                  propertyManagerOpen={propertyManagerOpen}
                  activeContextModelName={activeContextModelName}
                  onEnterEdit={onEnterEdit}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Search results — three states (driven by query + visible matches):
            1. query empty       → nothing
            2. query + matches   → chip list + "Search entire graph" tail
            3. query + no match  → escalation card pointing at Advanced Search */}
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
              'flex items-center gap-3 px-3.5 py-2.5 rounded-xl',
              'border-l-4 border-l-accent-lineage border border-accent-lineage/40',
              'bg-accent-lineage/[0.10] dark:bg-accent-lineage/[0.12]',
              'shadow-[0_0_18px_-6px_rgba(99,102,241,0.35)]',
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
                    'shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg',
                    'bg-accent-lineage text-white text-[12px] font-semibold',
                    'shadow-lg shadow-accent-lineage/30',
                    'hover:bg-accent-lineage/90 hover:shadow-accent-lineage/40',
                    'transition-all active:scale-[0.98]',
                  )}
                >
                  <LucideIcons.Globe className="w-3.5 h-3.5" strokeWidth={2.4} />
                  Search entire graph
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
            {onOpenAdvancedSearch && (
              <button
                onClick={() => onOpenAdvancedSearch(searchQuery.trim() || undefined)}
                title="Open Advanced Search — scans the full graph at any depth"
                className={cn(
                  'ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl',
                  'text-xs font-medium',
                  'bg-accent-lineage/10 text-accent-lineage',
                  'border border-accent-lineage/30 hover:border-accent-lineage/60',
                  'hover:bg-accent-lineage/20 transition-all',
                )}
              >
                <LucideIcons.Globe className="w-3 h-3" strokeWidth={2.4} />
                Search entire graph
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
