/**
 * CanvasToolRow — the toolbar of the Graph and Hierarchy canvases, one row for both views.
 *
 * Their tools used to be few and Technical-only: a floating Properties button, a Graph header with
 * Flow and LOD switches, and a Canvas Controls panel the Business view never saw. The row is now
 * the Context View's own tools (`CanvasTools`): Lineage, Display, the Focus Lens, Trace,
 * Properties, Import / Export and, in the Business view, More. Then Edit on Published, or Undo,
 * Redo and Review & Save in a draft. The labels fold away short of room, as the Context View's do.
 *
 * The row also holds what its buttons open: the Focus Lens, the Start editing dialog, and Import
 * and Export. Each canvas brings what is its own: its name and extras on the left, its search, its
 * Display menu, and its trace.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { useFeature } from '@/store/features'
import { usePreferencesStore } from '@/store/preferences'
import { useActiveView } from '@/store/schema'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { useWorkspacesStore } from '@/store/workspaces'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { releaseProviderCaches } from '@/providers/providerPool'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { invalidateAggregatedEdges } from '@/hooks/useAggregatedLineage'
import { useLensChildren } from '@/hooks/useLensChildren'
import { useLensWalk } from '@/hooks/useLensWalk'
import { VERSIONING_KEYS, useResolveGraph } from '@/features/versioning/hooks/useVersioning'
import { useCanvasEditGate } from '@/features/versioning/canvas/useDraftSave'
import { DraftSaveControls } from '@/features/versioning/canvas/DraftSaveControls'
import { ImportDialog } from '@/features/import-export/ImportDialog'
import { ExportDialog } from '@/features/import-export/ExportDialog'
import { CanvasTools, EditEntry } from './context-view/header/ViewerActions'
import { ToolbarFoldProvider, useToolbarFold } from './context-view/header/toolbarFold'
import { StartEditingDialog } from './context-view/StartEditingDialog'
import { LineageLens } from './context-view/LineageLens'
import {
  EMPTY_LENS_HISTORY, lensBackward, lensFocalOf, lensForwardStep, lensJump, lensPush, type LensHistory,
} from './context-view/lens/lensHistory'

export interface CanvasToolRowProps {
  /** Left of the search: the canvas's name, and its Technical extras. */
  lead?: ReactNode
  /** Between the lead and the tools. */
  search: ReactNode
  /** The canvas's Display menu (CanvasDisplayMenu). */
  display: ReactNode
  /** Under the row: what the search found. */
  children?: ReactNode
  /** The lineage lines' switch. Absent on a canvas that draws none. */
  showLineageFlow?: boolean
  onToggleLineageFlow?: () => void
  /** The canvas's own trace: it starts on the one entity selected. */
  traceActive: boolean
  onStartTrace: (nodeId: string) => void
  onExitTrace: () => void
  /** Plain clicks add to the selection. */
  multiSelectArmed: boolean
  onToggleMultiSelect: () => void
  propertyManagerOpen: boolean
  /** Absent without a view to browse. */
  onTogglePropertyManager?: () => void
  /** Shows an entity on the canvas, for the Focus Lens. */
  onRevealOnCanvas: (nodeId: string) => void
}

export function CanvasToolRow({
  lead, search, display, children, showLineageFlow, onToggleLineageFlow, traceActive, onStartTrace,
  onExitTrace, multiSelectArmed, onToggleMultiSelect, propertyManagerOpen, onTogglePropertyManager,
  onRevealOnCanvas,
}: CanvasToolRowProps) {
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  // Trace and the Lens each walk from one entity on these canvases.
  const single = selectedNodeIds.length === 1 ? selectedNodeIds[0] : null
  const lineageReady = useCanvasStore((s) => s.hydrationPhase === 'complete')

  // The same terms as the Context View's Edit entry and Import / Export.
  const { scopeWsId, dataSourceId, viewId, graphId, branchId, isDraft } = useCanvasEditGate()
  const activeView = useActiveView()
  const canManage = usePermission('workspace:datasource:manage', scopeWsId ?? undefined)
  const versioningEnabled = useFeature('versioningEnabled')
  const viewExecCtx = useViewExecutionContext()
  const readOnly = viewExecCtx?.readOnly ?? false
  const asOfSeq = viewExecCtx?.asOfSeq ?? null
  const canEnterEdit = !!graphId && !readOnly && asOfSeq == null
  // The drafts manager is the branch switcher's, in the versioning bar above the canvas.
  const openDrafts = versioningEnabled && !readOnly && !!scopeWsId && canEnterEdit && !isDraft
    ? () => useVersioningPanelStore.getState().setDraftsOpen(true)
    : undefined

  const [startEditing, setStartEditing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  // Asked only for an export: whether the source is still being put under version control, when
  // the export is a live one. The versioning bar has usually asked already.
  const resolveQ = useResolveGraph(exporting ? scopeWsId ?? undefined : undefined, dataSourceId, viewId)
  const dataSourceName = useWorkspacesStore((s) => s.workspaces
    .find((w) => w.id === scopeWsId)?.dataSources?.find((d) => d.id === dataSourceId)?.label)
  // An import writes to the draft on the server; the canvas reads it again once the dialog closes.
  const queryClient = useQueryClient()
  const importedRef = useRef(false)
  const rereadAfterImport = () => {
    if (!importedRef.current) return
    importedRef.current = false
    queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
    invalidateAggregatedEdges()
    releaseProviderCaches()
    useBranchStore.getState().bumpDraftEpoch()
    useBranchStore.getState().setCommittedDiffHidden(false)
  }

  // The Focus Lens, over the canvas: one entity's connections, walked hop by hop.
  const provider = useGraphProviderIfAvailable()
  const [lensHistory, setLensHistory] = useState<LensHistory>(EMPTY_LENS_HISTORY)
  const lensFocal = lensFocalOf(lensHistory)
  const [lensFullWalk, setLensFullWalk] = useState(false)
  const lensDepth = usePreferencesStore((s) => s.lensInitialDepth)
  const lensWalk = useLensWalk(lensFocal, provider, lensDepth, lensFullWalk)
  const lensChildren = useLensChildren(lensFocal, provider)
  const { extend, page, retry, pageSeeds } = lensWalk
  const lensWalkApi = useMemo(() => ({ extend, page, retry, pageSeeds }), [extend, page, retry, pageSeeds])
  const lensLabelFor = useCallback((urn: string): string | null => {
    const data = useCanvasStore.getState().nodes.find((n) => n.id === urn)?.data as { label?: string } | undefined
    return data?.label ?? null
  }, [])

  const rowRef = useRef<HTMLDivElement>(null)
  const leadRef = useRef<HTMLDivElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const fold = useToolbarFold(rowRef, leadRef, actionsRef)

  return (
    // No backdrop-blur: nothing scrolls beneath the row to blur, and a blur would make it a stacking
    // context its buttons' popovers could not paint out of.
    <div data-canvas-toolbar className="flex-shrink-0 bg-canvas-elevated/95 border-b border-glass-border px-6 py-3">
      <div
        ref={rowRef}
        className={cn('grid items-center gap-4', fold.stacked ? 'grid-cols-[auto_1fr]' : 'grid-cols-[auto_1fr_auto]')}
      >
        <div ref={leadRef} className="flex items-center gap-2 min-w-0">{lead}</div>
        <div className="flex items-center gap-2 min-w-0">{search}</div>
        <div ref={actionsRef} className={cn(fold.stacked && 'col-span-full justify-self-end max-w-full')}>
          <ToolbarFoldProvider value={fold.folded}>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <CanvasTools
                showLineageFlow={showLineageFlow}
                onToggleLineageFlow={onToggleLineageFlow}
                display={display}
                traceActive={traceActive}
                canTrace={!!single}
                canOpenLens={!!single}
                onStartTrace={() => { if (single) onStartTrace(single) }}
                onExitTrace={onExitTrace}
                lineageReady={lineageReady}
                multiSelectArmed={multiSelectArmed}
                onToggleMultiSelect={onToggleMultiSelect}
                onOpenLens={() => { if (single) setLensHistory({ entries: [single], cursor: 0 }) }}
                onOpenDrafts={openDrafts}
                propertyManagerOpen={propertyManagerOpen}
                onTogglePropertyManager={onTogglePropertyManager}
                onImport={graphId && scopeWsId ? () => setImporting(true) : undefined}
                onExport={scopeWsId && dataSourceId ? () => setExporting(true) : undefined}
                isDraft={isDraft}
              />
              {isDraft ? (
                <>
                  <div className="w-px h-6 bg-gradient-to-b from-transparent via-black/15 dark:via-white/10 to-transparent" />
                  <DraftSaveControls />
                </>
              ) : (
                <EditEntry canManage={canManage} canEnterEdit={canEnterEdit} onEnterEdit={() => setStartEditing(true)} />
              )}
            </div>
          </ToolbarFoldProvider>
        </div>
      </div>
      {children}

      <LineageLens
        history={lensHistory}
        walk={lensFocal ? lensWalk.walkFor(lensFocal) : null}
        walkApi={lensWalkApi}
        childrenAll={lensChildren.allResults}
        childrenAllStatus={lensChildren.allStatus}
        onLoadAllChildren={lensChildren.loadAllChildren}
        onLoadChildrenOf={lensChildren.loadChildrenOf}
        onRecenter={(nodeId) => setLensHistory((h) => lensPush(h, nodeId))}
        onBack={() => setLensHistory(lensBackward)}
        onForward={() => setLensHistory(lensForwardStep)}
        onJumpTo={(index) => setLensHistory((h) => lensJump(h, index))}
        onClose={() => setLensHistory(EMPTY_LENS_HISTORY)}
        onRevealOnCanvas={onRevealOnCanvas}
        onOpenDetails={(nodeId) => useCanvasStore.getState().openNodeDrawer(nodeId)}
        fullWalkEnabled={lensFullWalk}
        walkProgress={lensFocal ? lensWalk.walkProgressFor(lensFocal) : null}
        labelHintFor={lensLabelFor}
        onFullWalkToggle={setLensFullWalk}
        onWalkContinue={() => { if (lensFocal) lensWalk.continuePastCheckpoint(lensFocal) }}
        onWalkRetry={() => { if (lensFocal) lensWalk.retryWalk(lensFocal) }}
      />

      {startEditing && graphId && scopeWsId && (
        <StartEditingDialog
          wsId={scopeWsId}
          graphId={graphId}
          viewId={viewId}
          dataSourceId={dataSourceId}
          onClose={() => setStartEditing(false)}
        />
      )}
      {importing && graphId && scopeWsId && (
        <ImportDialog
          wsId={scopeWsId}
          graphId={graphId}
          branchId={branchId ?? undefined}
          viewId={viewId ?? undefined}
          onClose={() => { setImporting(false); rereadAfterImport() }}
          onReviewChanges={() => {
            setImporting(false)
            useVersioningPanelStore.getState().openPanel('changes')
            rereadAfterImport()
          }}
          onImported={() => { importedRef.current = true }}
        />
      )}
      {/* Export works on Published and in a draft, with or without version control: a source
          without it (or still being put under it) exports its live graph. */}
      {exporting && scopeWsId && dataSourceId && !resolveQ.isLoading && (
        <ExportDialog
          wsId={scopeWsId}
          dataSourceId={dataSourceId}
          graphId={resolveQ.data && !resolveQ.data.bootstrap ? resolveQ.data.graphId : null}
          dataSourceName={dataSourceName}
          viewId={viewId ?? undefined}
          viewName={activeView?.name}
          branchId={branchId ?? undefined}
          asOfSeq={asOfSeq}
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  )
}
