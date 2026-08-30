/**
 * CanvasRouter - Thin routing shell that switches between canvas types
 *
 * Renders the appropriate canvas component based on the view's layout type:
 * - 'graph' → GraphCanvas (unified React Flow graph, replaces LineageCanvas)
 * - 'hierarchy' | 'tree' → HierarchyCanvas (Hierarchy-style nested view)
 * - 'reference' → ReferenceModelCanvas (context view)
 * - 'layered-lineage' → GraphCanvas (unified React Flow graph, replaces LayeredLineageCanvas)
 *
 * All data loading is handled by useGraphHydration (called here and in canvas components).
 */

import { Suspense, useMemo, useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useGraphHydration } from '@/hooks/useGraphHydration'
import { useLoadingNotification, useNotificationStore } from '@/components/ui/notifications'
import { useCanvasStore } from '@/store/canvas'
import { useTraceStore } from '@/hooks/useUnifiedTrace'
import { useBranchStore } from '@/store/branchStore'
import { useFeature } from '@/store/features'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { CanvasVersioningBar } from '@/features/versioning/components/CanvasVersioningBar'
import { useStagedDraftPersistence } from '@/features/canvas-drafts/useStagedDraftPersistence'
import { RestoredDraftBanner } from '@/features/canvas-drafts/RestoredDraftBanner'
import { CanvasProviderStateOverlay } from './CanvasProviderStateOverlay'
import { useAutoDraftForBlankModel } from '@/features/versioning/model/useAutoDraftForBlankModel'
import { GraphCanvas } from './GraphCanvas'
import { HierarchyCanvas } from './HierarchyCanvas'
import { ReferenceModelCanvas } from './ReferenceModelCanvas'
import { cn } from '@/lib/utils'
import { viewTypeLabel } from '@/lib/domainLabels'

interface CanvasRouterProps {
  className?: string
  /** Override the layout type used for canvas selection.
   *
   * ViewPage passes this directly from useViewNavigation() so the correct
   * canvas renders even when the schema store's activeViewId races with
   * loadFromBackend during a cross-workspace scope transition.
   * Without this prop, CanvasRouter falls back to getActiveView()?.layout.type
   * which may be undefined if loadFromBackend hasn't re-set activeViewId yet.
   */
  layoutType?: string
}

export function CanvasRouter({ className, layoutType: layoutTypeProp }: CanvasRouterProps) {
  const activeView = useSchemaStore((s) => s.getActiveView())
  const versioningEnabled = useFeature('versioningEnabled')
  // Read-only capability sessions get no versioning chrome — drafts,
  // branch switching, and publish are all writes the backend would 403.
  const viewExecCtx = useViewExecutionContext()
  const { providerVersion } = useGraphProviderContext()
  // Prefer the prop (from navigation pipeline) over the store lookup.
  // This avoids the race where loadFromBackend resets activeViewId to null
  // during a cross-workspace transition, causing a 'graph' fallback.
  const layoutType = layoutTypeProp ?? activeView?.layout.type ?? 'graph'

  // Single source of truth for initial graph data loading.
  // Only CanvasRouter passes hydrate=true — canvas components use the hook
  // without hydration (loadChildren/searchChildren only).
  const { hydrationStatus, hydrationPhase, retryHydration, isLoading: isHydrating } = useGraphHydration({ hydrate: true })
  const isInitialLoad = isHydrating && hydrationPhase !== 'complete'
  useLoadingNotification(
    'hydration',
    isInitialLoad && hydrationStatus === 'loading',
    hydrationPhase === 'roots' ? 'Loading entities' : hydrationPhase === 'edges' ? 'Loading edges' : 'Preparing view',
    'Canvas ready',
    // Never announce "Canvas ready" when the load ended warming/unavailable.
    hydrationStatus === 'warming' || hydrationStatus === 'unavailable',
  )

  // Mirror hydration phase + status into the canvas store so downstream
  // components (ContextViewCanvas empty-state/notifications, LayerColumn ghost cards,
  // GhostLineageOverlay) derive their UI from ONE authoritative source and
  // never render a failed/loading load as an empty graph.
  const setHydrationPhase = useCanvasStore((s) => s.setHydrationPhase)
  useEffect(() => {
    setHydrationPhase(hydrationPhase)
  }, [hydrationPhase, setHydrationPhase])

  const setHydrationStatus = useCanvasStore((s) => s.setHydrationStatus)
  useEffect(() => {
    setHydrationStatus(hydrationStatus)
  }, [hydrationStatus, setHydrationStatus])

  // Clear trace state when the active view changes. The trace store is an
  // app-singleton; without this, a trace started in view A leaks into view
  // B (different data, different URNs) and the dock stays open against an
  // unrelated canvas. Stale trace-added edges in the canvas store are
  // wiped naturally by view B's hydration cycle, so only the trace state
  // needs explicit cleanup here.
  // Also clears on branch switch: a draft and main are different graph states, so a
  // trace started on one must not bleed onto the other (the canvas rehydrates from the
  // branch-scoped provider when currentBranchId changes — see ViewExecutionContext).
  const activeViewId = activeView?.id
  const currentBranchId = useBranchStore((s) => s.currentBranchId)
  useEffect(() => {
    const { clearTrace, resetAddedEdgeIds } = useTraceStore.getState()
    clearTrace()
    resetAddedEdgeIds()
    // Same reasoning for the notification message log the status chips surface: it is
    // an app singleton, so without this the messages raised while view A was
    // open would be listed as view B's. In memory only — no persistence, so a
    // refresh starts clean too.
    useNotificationStore.getState().clearHistory()
  }, [activeViewId, currentBranchId])

  // Scope staged changes to the active (workspace, data source, branch). Staged edits belong to
  // ONE branch — a draft is isolated until merged — so switching branches must PARK the current
  // branch's staged edits and load the target branch's slice (empty for a fresh branch). Without
  // this the staged store is a global singleton, so a delete staged on branch "123" bleeds onto
  // branch "456"/"789"'s canvas + containment tree (which read the staged store), making it look
  // like an unmerged change leaked across branches. (Symmetric to the trace clear above; the
  // canvas itself rehydrates from the branch-scoped provider via ViewExecutionContext.)
  const scopeWs = useBranchStore((s) => s.workspaceId)
  const scopeDs = useBranchStore((s) => s.dataSourceId)
  const stagedScopeKey = `${scopeWs ?? ''}::${scopeDs ?? ''}::${currentBranchId ?? 'main'}`
  useEffect(() => {
    useStagedChangesStore.getState().setScope(stagedScopeKey)
  }, [stagedScopeKey])

  // Persist unsaved staged work to localStorage under the same scope key so a
  // refresh restores it (with a banner) instead of losing it. Only meaningful
  // in a draft (staged edits require an open branch); on 'main' the snapshot
  // stays empty. See features/canvas-drafts/.
  const { restoredCount, dismissRestored, discardAllStaged } = useStagedDraftPersistence(
    currentBranchId ? stagedScopeKey : null,
    currentBranchId,
    hydrationPhase === 'complete',
  )

  // A brand-new blank model opens ready to build: auto-open (or resume) the
  // caller's draft once per graph per session. No-op for every other graph kind.
  useAutoDraftForBlankModel(activeView?.workspaceId ?? null, activeView?.dataSourceId ?? null, activeView?.id ?? null)

  // Memoize canvas selection based on view layout type
  const CanvasComponent = useMemo(() => {
    if (layoutType === 'layered-lineage') return GraphCanvas
    if (layoutType === 'reference') return ReferenceModelCanvas

    switch (layoutType) {
      case 'hierarchy':
      case 'tree':
        return HierarchyCanvas
      case 'graph':
      default:
        return GraphCanvas
    }
  }, [layoutType])

  return (
    <ErrorBoundary
      resetKeys={[activeView?.id, providerVersion]}
      fallback={(error, reset) => <CanvasError error={error} onRetry={reset} />}
    >
    <ReactFlowProvider>
    <div className={cn("relative w-full h-full flex flex-col", className)}>
      {/* The "you're behind Published" banner lives INSIDE CanvasVersioningBar (PullBeforeMergeBanner),
          which now reads the same polled freshness signal BranchBehindBanner used to own. There were
          two banners saying the same thing — one polled and thin, one derived and rich — and both
          could render at once for the same draft. */}
      {versioningEnabled && activeView?.workspaceId && !viewExecCtx?.readOnly && (
        <CanvasVersioningBar
          workspaceId={activeView.workspaceId}
          dataSourceId={activeView.dataSourceId ?? null}
        />
      )}
      <RestoredDraftBanner
        count={restoredCount}
        onDiscard={discardAllStaged}
        onDismiss={dismissRestored}
        className="mx-4 mt-2"
      />
      <div className="relative flex-1 min-h-0">
        <AnimatePresence>
          <motion.div
            key={layoutType}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="absolute inset-0"
          >
            <Suspense fallback={<CanvasLoader />}>
              <CanvasComponent />
            </Suspense>
          </motion.div>
        </AnimatePresence>

        {(hydrationStatus === 'warming' || hydrationStatus === 'unavailable') && (
          <CanvasProviderStateOverlay
            warming={hydrationStatus === 'warming'}
            onRetry={retryHydration}
          />
        )}

        {activeView && layoutType !== 'graph' && layoutType !== 'reference' && (
          <div className="absolute top-4 left-4 z-10 pointer-events-none">
            <ViewBadge
              name={activeView.name}
              layoutType={layoutType}
              entityCount={activeView.content.visibleEntityTypes.length}
            />
          </div>
        )}
      </div>
    </div>
    </ReactFlowProvider>
    </ErrorBoundary>
  )
}

function CanvasError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="w-full h-full flex items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-950/40 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6 text-red-500" />
        </div>
        <h3 className="text-lg font-semibold text-ink">This view encountered an error</h3>
        <p className="text-sm text-ink-muted">{error.message}</p>
        <button
          onClick={onRetry}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent-lineage text-white text-sm font-medium hover:bg-accent-lineage/90 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      </div>
    </div>
  )
}

function CanvasLoader() {
  return (
    <div className="w-full h-full flex items-center justify-center bg-canvas">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-accent-lineage" />
        <span className="text-sm text-ink-muted">Loading view...</span>
      </div>
    </div>
  )
}

interface ViewBadgeProps {
  name: string
  layoutType: string
  entityCount: number
}

function ViewBadge({ name, layoutType, entityCount }: ViewBadgeProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{name}</span>
        <span className="px-1.5 py-0.5 rounded text-2xs font-medium bg-accent-lineage/10 text-accent-lineage">
          {viewTypeLabel(layoutType)}
        </span>
        <span className="text-2xs text-ink-muted">
          {entityCount} types
        </span>
      </div>
    </div>
  )
}

export default CanvasRouter
