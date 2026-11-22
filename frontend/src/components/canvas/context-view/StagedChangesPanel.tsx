/**
 * Review & Save — one guided place to take staged edits from the canvas to the draft, and on to
 * the Published version.
 *
 *   1. **Review** what will be saved, in words (List) or drawn (Map) — built for tens of thousands
 *      of changes: a filter bar (what, how, which type, a search, what needs attention), a
 *      virtualized list moved through with the keyboard, and the selected change beside it, saying
 *      what it does ("Renamed orders to Orders v2") with only the fields the save sends, shown as
 *      the values they are. Undo / Redo, discard one, the N shown, or all. What the draft already
 *      holds from earlier saves and imports is listed beneath, a page at a time — the same list
 *      as Changes & Reviews. With nothing staged, that list is what opens, with **Publish this
 *      draft…** as the next step.
 *   2. **Save** — to the draft (and keep editing; save as often as you like), or save and go
 *      straight on to publishing or to a review.
 *   3. **Publish** — the shared publish flow (`PublishForm`), its title taken from what was saved,
 *      over the whole draft, not just this batch. Offered only when there is something to publish;
 *      its Back returns to the list.
 *
 * Theme-aware (light and dark). A save or publish in flight holds the dialog: nothing in it is
 * closed, discarded or undone until it settles.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle, Check, CheckCircle2, ChevronRight, FileStack, GitPullRequest,
  Layers, List, ListTree, Loader2, Map as MapIcon, OctagonAlert, Rocket, Save, Undo2, Redo2, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSaveProgressStore } from '@/store/saveProgressStore'
import { formatShortcut } from '@/lib/platform'
import { useBranchStore } from '@/store/branchStore'
import { usePermission } from '@/store/auth'
import { liveProblems, useSaveProblemsStore } from '@/store/saveProblemsStore'
import type { SaveProblem } from '@/features/versioning/model/saveProblems'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { Segmented } from '@/components/ui/Segmented'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { describeScope, suggestTitle } from '@/features/versioning/model/reviewModel'
import {
  buildReviewIndex, filterRows, isNarrowed, needsAttention, NO_FILTER, rowKey, type ReviewFilter, type ReviewIndex,
} from '@/features/versioning/model/reviewIndex'
import { fromChangeCounts } from '@/features/versioning/model/changeAdapters'
import { EMPTY_CHANGE_SET, type ChangeSet, type ChangeStatus } from '@/features/versioning/model/changeModel'
import { useChangeSummary, useDataSourceDraftsPolicy } from '@/features/versioning/hooks/useVersioning'
import { useActiveDraftAccess } from '@/features/versioning/hooks/useActiveDraftAccess'
import { ChangesPanel, ChangeCountChips } from '@/features/versioning/components/ChangesPanel'
import { ChangeList } from '@/features/versioning/components/ChangeList'
import { useChangeListLayout } from '@/features/versioning/hooks/useChangeListLayout'
import { STATUS_META } from '@/features/versioning/components/NodeDiffBadge'
import { PublishActions, PublishBody, usePublishFlow } from '@/features/versioning/components/PublishForm'
import { ReviewExplorer, ReviewFilterBar } from './review/ReviewExplorer'
import { canvasLookup } from './review/canvasLookup'
import { stagedCsvLines } from '@/features/versioning/model/reviewCsv'
import { downloadCsv } from '@/lib/csv'
import { stopsFromGroups, useChangeNavigatorStore } from '@/store/changeNavigatorStore'

// Drawn only when the Map is opened: React Flow and the layout engine stay out of the first paint.
const ChangeMap = lazy(() => import('@/features/versioning/components/ChangeMap'))

const EMPTY_INDEX: ReviewIndex = {
  groups: [], groupOf: new Map(), headingCounts: new Map(),
  facets: { status: { added: 0, modified: 0, removed: 0 }, kind: { node: 0, edge: 0, layout: 0 }, types: [] },
}

/** A save (or a publish from here) is in flight: until it settles the review stays open and nothing
 *  in it is discarded or undone. */
const saving = () => useStagedChangesStore.getState().applyStatus === 'applying'

export type ReviewDestination = 'draft' | 'publish' | 'review'

export interface SaveConfirmationModalProps {
  /** Save the staged changes. Resolves true once they are written (the dialog then closes, or goes
   *  on to Publish); anything else leaves it open on the review — its problems, if any, shown. */
  onConfirm: () => boolean | void | Promise<boolean | void>
  /** Words a change from the CURRENT state when its staged summary can go out of date — a
   *  placement names its group and layer, and the group may since have been renamed or moved to
   *  another layer. Returns undefined to keep the staged summary. */
  describe?: (change: StagedChange) => string | undefined
  /** The draft's graph, for the Publish step. Without them, Review & Save only saves. */
  wsId?: string | null
  graphId?: string | null
  dataSourceId?: string | null
  viewId?: string | null
  /** Show an entity on the canvas (the dialog closes first). */
  onReveal?: (nodeId: string) => void
}

export function StagedChangesPanel({ onConfirm, describe, wsId, graphId, dataSourceId, viewId, onReveal }: SaveConfirmationModalProps) {
  const isOpen = useStagedChangesStore(s => s.isReviewPanelOpen)
  const close = useStagedChangesStore(s => s.closeReviewPanel)
  const intent = useStagedChangesStore(s => s.reviewIntent)
  const stagedChanges = useStagedChangesStore(s => s.changes)
  // Nothing per change is worked out while the dialog is closed.
  const changes = useMemo(() => (describe && isOpen
    ? stagedChanges.map(c => { const now = describe(c); return now && now !== c.summary ? { ...c, summary: now } : c })
    : stagedChanges), [stagedChanges, describe, isOpen])
  const discardAll = useStagedChangesStore(s => s.discardAll)
  const applyStatus = useStagedChangesStore(s => s.applyStatus)
  const lastApplyResult = useStagedChangesStore(s => s.lastApplyResult)
  const undo = useStagedChangesStore(s => s.undo)
  const redo = useStagedChangesStore(s => s.redo)
  const redoStack = useStagedChangesStore(s => s.redoStack)
  const past = useStagedChangesStore(s => s.past)
  const branchId = useBranchStore(s => s.currentBranchId)
  const draftChanges = useBranchStore(s => s.activeChangeSet)
  const closeUnlessSaving = useCallback(() => { if (!saving()) close() }, [close])
  const discardUnlessSaving = (ids: string[]) => {
    if (saving() || ids.length === 0) return
    const s = useStagedChangesStore.getState()
    if (ids.length === 1) s.discard(ids[0])
    else s.discardMany(ids)
  }

  const draftCount = draftChanges ? draftChanges.counts.added + draftChanges.counts.modified + draftChanges.counts.removed : 0
  // Publishing needs the draft's graph; a host that gives none (or Published) only saves here.
  const canPublishHere = !!(wsId && graphId && branchId)

  const [step, setStep] = useState<'review' | 'publish'>('review')
  const [destination, setDestination] = useState<ReviewDestination>('draft')
  const [view, setView] = useState<'list' | 'map'>('list')
  // The list top-down or as one list — the same choice as every change list.
  const [layout, setLayout] = useChangeListLayout()
  const [filter, setFilter] = useState<ReviewFilter>(NO_FILTER)
  /** The selected row (`rowKey`): the List's detail and the Map's highlight. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** Opened to look at what the draft holds (after an import): that list, open. */
  const [lookAtSaved, setLookAtSaved] = useState(false)
  /** What the last save carried, for the Publish step's title. */
  const [savedTitle, setSavedTitle] = useState('')
  const filterInputRef = useRef<HTMLInputElement>(null)

  // Each opening starts afresh, on the review — with nothing staged, on what the draft already
  // holds, so its changes are seen before Publish this draft… is chosen.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      const s = useStagedChangesStore.getState()
      // Opened to look at what the draft holds (an import just landed): that list, open even
      // beside staged edits — a page at a time, never 100,000 entities drawn.
      const toLook = s.reviewIntent === 'saved' && draftCount > 0
      setStep('review')
      setDestination(s.reviewIntent === 'publish' && canPublishHere ? 'publish' : 'draft')
      setView('list')
      setFilter(NO_FILTER)
      setSelectedKey(null)
      setLookAtSaved(toLook)
      setSavedTitle('')
    }
    wasOpen.current = isOpen
  }, [isOpen, draftCount, canPublishHere, intent])

  // ESC closes the dialog — single, predictable escape.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeUnlessSaving()
      } else if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        filterInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeUnlessSaving])

  const lookup = useMemo(() => canvasLookup(), [isOpen, changes]) // eslint-disable-line react-hooks/exhaustive-deps
  const index = useMemo(() => (isOpen ? buildReviewIndex(changes, lookup) : EMPTY_INDEX), [isOpen, changes, lookup])
  const groups = index.groups
  const layoutCount = index.facets.kind.layout

  const total = changes.length
  const failedCount = useMemo(() => (isOpen ? changes.filter(c => c.error).length : 0), [isOpen, changes])
  // Why the last save was refused (nothing was written) — the problems still tied to staged changes.
  const allProblems = useSaveProblemsStore(s => s.problems)
  const problems = useMemo(
    () => (isOpen && allProblems.length ? liveProblems(allProblems, new Set(changes.map(c => c.id))) : []),
    [isOpen, allProblems, changes],
  )
  const problemIds = useMemo(() => new Set(problems.flatMap(p => p.changeIds)), [problems])
  const rows = useMemo(() => filterRows(index, filter, problemIds), [index, filter, problemIds])
  const attention = useMemo(() => groups.reduce((n, g) => n + (needsAttention(g, problemIds) ? 1 : 0), 0), [groups, problemIds])
  const shownGroups = useMemo(() => rows.map(i => groups[i]), [rows, groups])
  const counts = index.facets.status
  const [exporting, setExporting] = useState(false)
  const exportShown = async (detail: 'changes' | 'properties') => {
    setExporting(true)
    try {
      downloadCsv(`staged-changes${detail === 'properties' ? '-properties' : ''}.csv`, await stagedCsvLines(shownGroups, detail))
    } finally {
      setExporting(false)
    }
  }
  const discardShown = () => {
    const ids = shownGroups.flatMap(g => g.changes.map(c => c.id))
    const n = shownGroups.length
    if (confirm(`Discard the ${n.toLocaleString()} change${n === 1 ? '' : 's'} shown? Redo brings back all but new entities.`)) {
      discardUnlessSaving(ids)
    }
  }

  const handleConfirm = async () => {
    // One save at a time: a second press while one runs would send the same batch again.
    if (saving()) return
    const title = suggestTitle(groups)
    useStagedChangesStore.setState({ applyStatus: 'applying' })
    let ok = false
    try {
      ok = (await onConfirm()) === true
    } finally {
      if (saving()) useStagedChangesStore.setState({ applyStatus: 'idle' })
    }
    if (!ok) return
    if (destination === 'draft' || !canPublishHere) {
      close()
      return
    }
    setSavedTitle(title)
    setStep('publish')
  }

  const reveal = onReveal ? (id: string) => { if (!saving()) { close(); onReveal(id) } } : undefined
  // Walk what is shown, on the canvas, from the selected one (the dialog closes for it).
  const canStep = useChangeNavigatorStore(s => s.canReveal)
  const stepThrough = canStep ? (key: string) => {
    if (saving()) return
    const stops = stopsFromGroups(shownGroups)
    const at = groups.find(g => rowKey(g) === key)?.revealId
    if (stops.length === 0) return
    close()
    useChangeNavigatorStore.getState().start(stops, { scope: 'unsaved', atId: at, narrowed: isNarrowed(filter) })
  } : undefined
  /** A group's row key from the key the Map knows it by. */
  const rowOf = (key: string) => {
    const g = groups.find(x => x.key === key && x.kind !== 'layout')
    return g ? rowKey(g) : null
  }
  const showInList = (key: string) => {
    setView('list')
    setFilter(NO_FILTER)
    setSelectedKey(rowOf(key))
  }
  const undoLabel = formatShortcut('mod+z')
  const redoLabel = formatShortcut('mod+shift+z')

  return createPortal(
    <>
      {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
          StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
      <Backdrop
        open={isOpen}
        onClick={closeUnlessSaving}
        zClassName="z-[80]"
        className="bg-black/40 backdrop-blur-sm"
      />

      {/* Centering layer: plain, always-mounted, transparent to clicks (they fall
          through to the Backdrop beneath → outside-click still closes). */}
      <div className="fixed inset-0 z-[81] flex items-center justify-center px-4 py-6 pointer-events-none">
        <AnimatePresence>
          {isOpen && (
            <motion.div
              key="staged-modal-card"
              initial={{ opacity: 0, scale: 0.97, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 6 }}
              transition={{ type: 'spring', damping: 30, stiffness: 340 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="staged-modal-title"
              className="pointer-events-auto relative w-full max-w-[1120px] max-h-[min(900px,100%)] flex flex-col rounded-3xl overflow-hidden bg-canvas-elevated border border-glass-border shadow-glass-lg"
              data-canvas-interactive
            >
            {/* Header */}
            <div className="relative flex-shrink-0 px-6 pt-5 pb-4 border-b border-glass-border bg-gradient-to-b from-accent-lineage/[0.06] to-transparent">
              <button
                onClick={closeUnlessSaving}
                className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-start gap-3.5 pr-10">
                <div className="relative w-11 h-11 rounded-2xl bg-accent-lineage/12 border border-accent-lineage/25 flex items-center justify-center flex-shrink-0">
                  {step === 'publish' ? <Rocket className="w-5 h-5 text-accent-lineage" /> : <FileStack className="w-5 h-5 text-accent-lineage" />}
                  {total > 0 && step === 'review' && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 rounded-full bg-accent-lineage text-white text-[10px] font-bold flex items-center justify-center px-1.5 shadow ring-2 ring-canvas-elevated tabular-nums">
                      {total.toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 id="staged-modal-title" className="text-[17px] font-display font-bold text-ink tracking-tight leading-tight">
                    Review &amp; Save Changes
                  </h3>
                  <p className="text-[12.5px] text-ink-secondary mt-0.5">
                    {step === 'publish'
                      ? (total === 0 && !savedTitle
                        ? 'Nothing new to save — publish what’s on this draft, or send it for review.'
                        : 'Saved to your draft. Publish it now, send it for review — or keep editing.')
                      : total === 0
                        ? (draftCount > 0
                          ? 'Nothing new to save — here’s what this draft already holds.'
                          : 'Nothing pending. Make some edits and they’ll show up here for review.')
                        : <>You’re changing <span className="font-semibold text-ink">{describeScope(groups)}</span>. Nothing is saved until you choose below.</>}
                    {failedCount > 0 && problems.length === 0 && step === 'review' && (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-semibold">
                        <AlertTriangle className="w-3 h-3" />
                        {failedCount.toLocaleString()} previously failed
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <StepTrail step={step} destination={destination} canPublish={canPublishHere} nothingToSave={total === 0 && !savedTitle} />

              {step === 'review' && problems.length > 0 && (
                <SaveProblemsBanner problems={problems} onDiscard={discardUnlessSaving} />
              )}

              {step === 'review' && (total > 0 || draftCount > 0) && (
                <div className="flex items-center gap-2 mt-4 flex-wrap">
                  <div className="flex items-center gap-1.5 flex-1 flex-wrap">
                    {counts.added > 0 && <SummaryChip status="added" count={counts.added} label="added" />}
                    {counts.modified > 0 && <SummaryChip status="modified" count={counts.modified} label="edited" />}
                    {counts.removed > 0 && <SummaryChip status="removed" count={counts.removed} label="removed" />}
                    {layoutCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-indigo-500/25 bg-indigo-500/[0.06] text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">
                        <Layers className="w-3 h-3" />{layoutCount} layout
                      </span>
                    )}
                  </div>
                  <Segmented
                    label="Show the changes as"
                    value={view === 'map' ? 'map' : layout}
                    onChange={(v) => { if (v === 'map') setView('map'); else { setView('list'); setLayout(v) } }}
                    options={[
                      { value: 'tree', label: 'Hierarchy', icon: ListTree },
                      { value: 'list', label: 'List', icon: List },
                      { value: 'map', label: 'Map', icon: MapIcon },
                    ]}
                  />
                  <UndoRedoCluster
                    canUndo={(changes.length > 0 || past.length > 0) && applyStatus !== 'applying'}
                    canRedo={redoStack.length > 0 && applyStatus !== 'applying'}
                    onUndo={undo}
                    onRedo={redo}
                    undoShortcut={undoLabel}
                    redoShortcut={redoLabel}
                  />
                </div>
              )}

              {step === 'review' && groups.length > 1 && (
                <div className="mt-3">
                  <ReviewFilterBar
                    index={index}
                    filter={filter}
                    onChange={setFilter}
                    shown={rows.length}
                    attention={attention}
                    onDiscardShown={discardShown}
                    onExport={(detail) => void exportShown(detail)}
                    exporting={exporting}
                    disabled={applyStatus === 'applying'}
                    searchRef={filterInputRef}
                  />
                </div>
              )}
            </div>

            {step === 'publish' && canPublishHere ? (
              <PublishStep
                wsId={wsId!}
                graphId={graphId!}
                branchId={branchId!}
                dataSourceId={dataSourceId ?? null}
                viewId={viewId ?? null}
                destination={destination}
                initialTitle={savedTitle}
                onBack={total > 0 || draftCount > 0 ? () => setStep('review') : undefined}
                onClose={close}
              />
            ) : (
              <>
                {/* Body */}
                <div className="relative flex-1 overflow-y-auto px-5 py-4 space-y-5 custom-scrollbar">
                  {view === 'map' && (groups.length > 0 || draftCount > 0) ? (
                    <Suspense fallback={<div className="h-[min(58vh,600px)] rounded-2xl border border-glass-border flex items-center justify-center text-xs text-ink-muted gap-2"><Loader2 className="w-4 h-4 animate-spin" />Drawing the map…</div>}>
                      <ChangeMap
                        groups={shownGroups}
                        saved={isNarrowed(filter) ? null : draftChanges}
                        nameOf={lookup.nameOf}
                        selectedKey={selectedKey ? selectedKey.slice(selectedKey.indexOf(':') + 1) : null}
                        onSelect={(key) => setSelectedKey(key ? rowOf(key) : null)}
                        onShowInList={showInList}
                        onReveal={reveal}
                        onShowCluster={(type, status) => {
                          setFilter({ ...NO_FILTER, kind: 'node', type, statuses: [status] })
                          setView('list')
                        }}
                      />
                    </Suspense>
                  ) : groups.length === 0 && draftCount > 0 ? null : (
                    <ReviewExplorer
                      index={index}
                      rows={rows}
                      narrowed={isNarrowed(filter)}
                      selected={selectedKey}
                      onSelect={setSelectedKey}
                      problemIds={problemIds}
                      onDiscard={discardUnlessSaving}
                      onReveal={reveal}
                      onStepThrough={stepThrough}
                      onClearFilter={() => setFilter(NO_FILTER)}
                      searchRef={filterInputRef}
                      disabled={applyStatus === 'applying'}
                    />
                  )}

                  {draftChanges && draftCount > 0 && view === 'list' && (
                    <DraftSavedSection
                      changeSet={draftChanges}
                      list={wsId && graphId && branchId ? { wsId, graphId, branchId } : null}
                      defaultOpen={total === 0 || lookAtSaved}
                    />
                  )}
                </div>

                {/* Destination + actions */}
                {total > 0 && (
                  <DestinationPicker
                    value={destination}
                    onChange={setDestination}
                    publishContext={canPublishHere ? { wsId: wsId!, graphId: graphId!, branchId: branchId!, dataSourceId: dataSourceId ?? null, viewId: viewId ?? null } : null}
                    disabled={applyStatus === 'applying'}
                  />
                )}
                <div className="relative flex-shrink-0 px-6 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center gap-2">
                  {total > 0 ? (
                    <>
                      <button
                        onClick={() => {
                          if (confirm(`Discard all ${total.toLocaleString()} staged change${total === 1 ? '' : 's'}? This cannot be undone.`)) {
                            discardAll()
                            close()
                          }
                        }}
                        disabled={applyStatus === 'applying'}
                        className="px-3 py-2 rounded-lg text-[12px] font-medium border border-glass-border text-ink-secondary hover:bg-rose-500/10 hover:border-rose-500/40 hover:text-rose-600 dark:hover:text-rose-300 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                      >
                        Discard all
                      </button>
                      <div className="flex-1" />
                      <button
                        onClick={closeUnlessSaving}
                        className="px-4 py-2 rounded-lg text-[13px] font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleConfirm}
                        disabled={applyStatus === 'applying'}
                        className={cn(
                          'flex items-center gap-2 px-5 py-2 rounded-xl text-[13px] font-bold transition-all',
                          applyStatus === 'applying'
                            ? 'bg-accent-lineage/15 text-accent-lineage cursor-wait'
                            : 'bg-accent-lineage text-white shadow-lg shadow-accent-lineage/25 hover:brightness-110 active:scale-[0.98]',
                        )}
                      >
                        {applyStatus === 'applying' ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <SaveProgressLabel />
                          </>
                        ) : destination === 'draft' || !canPublishHere ? (
                          <>
                            <Check className="w-4 h-4" strokeWidth={3} />
                            Save {total.toLocaleString()} change{total === 1 ? '' : 's'}
                          </>
                        ) : (
                          <>
                            <Save className="w-4 h-4" />
                            Save &amp; continue to {destination === 'publish' ? 'publish' : 'review'}
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex-1" />
                      {draftCount > 0 && canPublishHere && (
                        <button
                          onClick={() => setStep('publish')}
                          className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20"
                        >
                          <Rocket className="w-4 h-4" /> Publish this draft…
                        </button>
                      )}
                      <button
                        onClick={closeUnlessSaving}
                        className="px-5 py-2 rounded-lg text-[13px] font-medium border border-glass-border text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                      >
                        Close
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

            {applyStatus === 'partial-error' && lastApplyResult && (
              <div className="absolute bottom-[68px] left-6 right-6 px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/40 text-[11px] text-rose-700 dark:text-rose-200 flex items-center gap-2">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                Last save: <span className="font-semibold">{lastApplyResult.failed}</span> failed,{' '}
                <span className="font-semibold">{lastApplyResult.ok}</span> succeeded — review &amp; retry above.
              </div>
            )}
          </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>,
    document.body,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents

/** Review → Save → Publish, with where this review is in it. With nothing to save, Review →
 *  Publish: the draft's changes, then publishing them. */
function StepTrail({ step, destination, canPublish, nothingToSave }: {
  step: 'review' | 'publish'
  destination: ReviewDestination
  canPublish: boolean
  nothingToSave: boolean
}) {
  const steps: { label: string; state: 'done' | 'current' | 'next' | 'optional' }[] = [
    { label: 'Review', state: step === 'review' ? 'current' : 'done' },
    { label: 'Save to draft', state: step === 'publish' ? 'done' : 'next' },
    {
      label: destination === 'review' ? 'Send for review' : 'Publish',
      state: step === 'publish' ? 'current' : destination === 'draft' && !nothingToSave ? 'optional' : 'next',
    },
  ]
  if (nothingToSave) steps.splice(1, 1)
  if (!canPublish) steps.pop()
  return (
    <ol className="flex items-center gap-1.5 mt-3.5" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5" aria-current={s.state === 'current' ? 'step' : undefined}>
          {i > 0 && <span className={cn('w-6 h-px', s.state === 'done' || s.state === 'current' ? 'bg-accent-lineage/60' : 'bg-glass-border')} />}
          <span className={cn(
            'flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded-full text-[11px] font-semibold transition-colors',
            s.state === 'current' && 'bg-accent-lineage/12 text-accent-lineage',
            s.state === 'done' && 'text-emerald-600 dark:text-emerald-400',
            (s.state === 'next' || s.state === 'optional') && 'text-ink-muted',
          )}>
            <span className={cn(
              'w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold',
              s.state === 'current' && 'bg-accent-lineage text-white',
              s.state === 'done' && 'bg-emerald-500 text-white',
              (s.state === 'next' || s.state === 'optional') && 'border border-glass-border',
            )}>
              {s.state === 'done' ? <Check className="w-2.5 h-2.5" strokeWidth={3} /> : i + 1}
            </span>
            {s.label}
            {s.state === 'optional' && <span className="font-normal">· later</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

function SummaryChip({ status, count, label }: { status: ChangeStatus; count: number; label: string }) {
  const meta = STATUS_META[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold tabular-nums', meta.bg, meta.border, meta.text)}>
      <meta.Icon className="w-3 h-3" />
      <span className="font-bold">{count.toLocaleString()}</span>
      <span className="opacity-80">{label}</span>
    </span>
  )
}

function UndoRedoCluster({ canUndo, canRedo, onUndo, onRedo, undoShortcut, redoShortcut }: {
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  undoShortcut: string
  redoShortcut: string
}) {
  const btn = (enabled: boolean) => cn(
    'flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
    enabled ? 'text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]' : 'text-ink-muted/50 cursor-not-allowed',
  )
  return (
    <div className="flex items-stretch rounded-xl border border-glass-border overflow-hidden bg-black/[0.02] dark:bg-white/[0.03]">
      <HoverTip label="Undo the last change" shortcut={undoShortcut} className="flex">
        <button onClick={onUndo} disabled={!canUndo} className={btn(canUndo)} aria-label="Undo">
          <Undo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
          Undo
        </button>
      </HoverTip>
      <div className="w-px bg-glass-border" />
      <HoverTip label="Put back the change you just undid" shortcut={redoShortcut} className="flex">
        <button onClick={onRedo} disabled={!canRedo} className={btn(canRedo)} aria-label="Redo">
          Redo
          <Redo2 className="w-3.5 h-3.5" strokeWidth={2.4} />
        </button>
      </HoverTip>
    </div>
  )
}

/** What the draft already holds from earlier saves and imports — what publishing takes along too:
 *  read from the server a page at a time (an import of 100,000 entities opens as fast as one). */
function DraftSavedSection({ changeSet, list, defaultOpen = false }: {
  changeSet: ChangeSet
  list: { wsId: string; graphId: string; branchId: string } | null
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const origin = useMemo(() => (list ? { branchId: list.branchId } : null), [list?.branchId]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="rounded-2xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2.5 px-4 py-3 text-left"
      >
        <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted transition-transform', open && 'rotate-90')} />
        <CheckCircle2 className="w-4 h-4 text-emerald-500" aria-hidden />
        <span className="text-[12.5px] font-semibold text-ink">Already saved on this draft</span>
        <span className="text-[11px] text-ink-muted hidden sm:inline">earlier saves and imports — published with it</span>
        <span className="ml-auto"><ChangeCountChips changeSet={changeSet} /></span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {list && origin
            ? <ChangeList wsId={list.wsId} graphId={list.graphId} origin={origin} emptyHint="Nothing saved on this draft yet."
                restore={{ branchId: list.branchId }} />
            : <ChangesPanel changeSet={changeSet} emptyHint="Nothing saved on this draft yet." />}
        </div>
      )}
    </section>
  )
}

interface PublishContext { wsId: string; graphId: string; branchId: string; dataSourceId: string | null; viewId: string | null }

/** Where the save goes: the draft — or the draft, then on to publishing or a review. */
function DestinationPicker({ value, onChange, publishContext, disabled }: {
  value: ReviewDestination
  onChange: (d: ReviewDestination) => void
  publishContext: PublishContext | null
  disabled: boolean
}) {
  if (!publishContext) return null
  return <DestinationCards value={value} onChange={onChange} ctx={publishContext} disabled={disabled} />
}

function DestinationCards({ value, onChange, ctx, disabled }: {
  value: ReviewDestination
  onChange: (d: ReviewDestination) => void
  ctx: PublishContext
  disabled: boolean
}) {
  const canManage = usePermission('workspace:datasource:manage', ctx.wsId)
  const canPublish = usePermission('workspace:datasource:publish', ctx.wsId)
  const reviewOnly = useDataSourceDraftsPolicy(ctx.wsId, ctx.dataSourceId).data?.effective.selfMerge === false
  const access = useActiveDraftAccess(ctx.wsId, ctx.graphId, ctx.viewId, ctx.branchId)
  const publishBlocked = !canManage || !canPublish ? 'Publishing straight away needs the publish permission'
    : !access.canManage ? 'Only the draft’s owner or a maintainer publishes it directly'
    : reviewOnly ? 'This data source publishes through a review someone else merges'
    : null

  // Publishing straight away isn't open to this person: a review is the way to Published.
  useEffect(() => {
    if (value === 'publish' && publishBlocked) onChange('review')
  }, [value, publishBlocked, onChange])

  const options: { value: ReviewDestination; title: string; detail: string; icon: typeof Save; blocked: string | null }[] = [
    { value: 'draft', title: 'Save to draft', detail: 'Keep working — only this draft changes', icon: Save, blocked: null },
    { value: 'publish', title: 'Save & publish', detail: 'Everyone sees it right after', icon: Rocket, blocked: publishBlocked },
    // An open review already tracks the draft: the Publish step says so and goes to it.
    { value: 'review', title: 'Save & send for review', detail: 'Someone approves before it goes live', icon: GitPullRequest, blocked: null },
  ]
  return (
    <div className="flex-shrink-0 px-6 pt-3 pb-1 border-t border-glass-border">
      <p id="staged-destination" className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink-muted mb-2">Where should these go?</p>
      <div role="radiogroup" aria-labelledby="staged-destination" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {options.map(o => {
          const on = value === o.value
          const card = (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled || !!o.blocked}
              onClick={() => onChange(o.value)}
              className={cn(
                'w-full flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-45 disabled:cursor-not-allowed',
                on ? 'border-accent-lineage/60 bg-accent-lineage/[0.07] ring-1 ring-accent-lineage/30' : 'border-black/10 dark:border-white/10 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
              )}
            >
              <o.icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0', on ? 'text-accent-lineage' : 'text-ink-muted')} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-semibold text-ink">{o.title}</span>
                <span className="block text-[11px] text-ink-muted leading-snug">{o.detail}</span>
              </span>
            </button>
          )
          return o.blocked
            ? <HoverTip key={o.value} label={o.blocked} detail="Save to the draft, or send it for review" className="flex">{card}</HoverTip>
            : card
        })}
      </div>
    </div>
  )
}

/** The last step: the shared publish flow over the whole draft. */
function PublishStep({ wsId, graphId, branchId, dataSourceId, viewId, destination, initialTitle, onBack, onClose }: {
  wsId: string
  graphId: string
  branchId: string
  dataSourceId: string | null
  viewId: string | null
  destination: ReviewDestination
  initialTitle: string
  onBack?: () => void
  onClose: () => void
}) {
  // The whole draft's counts — just refetched by the save — not only what this save carried.
  const origin = useMemo(() => ({ branchId }), [branchId])
  const summaryQ = useChangeSummary(wsId, graphId, origin)
  const changeSet = useMemo(() => (summaryQ.data ? fromChangeCounts(summaryQ.data.counts) : EMPTY_CHANGE_SET), [summaryQ.data])
  const access = useActiveDraftAccess(wsId, graphId, viewId, branchId)
  const flow = usePublishFlow({
    workspaceId: wsId, graphId, branchId, changeSet, onClose, dataSourceId,
    canPublishDraft: access.canManage, initialTitle,
    changesLoading: summaryQ.isLoading || summaryQ.isFetching,
  })
  // A publish in flight holds the dialog, as a save does.
  useEffect(() => {
    useStagedChangesStore.setState({ applyStatus: flow.busy ? 'applying' : 'idle' })
    return () => { if (saving()) useStagedChangesStore.setState({ applyStatus: 'idle' }) }
  }, [flow.busy])

  return (
    <>
      <div className="relative flex-1 overflow-y-auto pt-4 custom-scrollbar">
        <PublishBody flow={flow} />
      </div>
      <div className="relative flex-shrink-0 px-6 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-end gap-3">
        <PublishActions
          flow={flow}
          emphasis={destination === 'publish' ? 'publish' : 'review'}
          leading={(
            <div className="mr-auto flex items-center gap-2">
              {onBack && (
                <button type="button" onClick={onBack} disabled={flow.busy}
                  className="px-3 py-2 rounded-lg text-[12.5px] font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] disabled:opacity-50">
                  Back to review
                </button>
              )}
              <HoverTip label="Keep it on the draft" detail="Everything is saved — publish any time from the toolbar" className="inline-flex">
                <button type="button" onClick={onClose} disabled={flow.busy}
                  className="px-3 py-2 rounded-lg text-[12.5px] font-medium text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.06] disabled:opacity-50">
                  Not now
                </button>
              </HoverTip>
            </div>
          )}
        />
      </div>
    </>
  )
}

/**
 * The last save was refused as a whole, so NOTHING was written. Say so first, then each problem —
 * what it is about and why — with the fix that is always available: discard the change that caused
 * it (the rest stay staged, ready to save again).
 */
function SaveProblemsBanner({ problems, onDiscard }: {
  problems: SaveProblem[]
  onDiscard: (changeIds: string[]) => void
}) {
  const n = problems.length
  return (
    <div
      role="alert"
      className="relative mt-4 rounded-2xl border border-rose-500/35 bg-rose-500/[0.07] px-4 py-3.5"
    >
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center flex-shrink-0">
          <OctagonAlert className="w-4 h-4 text-rose-600 dark:text-rose-300" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-ink leading-tight">Nothing was saved</p>
          <p className="text-[11.5px] text-ink-secondary leading-tight mt-0.5">
            {n === 1 ? '1 change needs attention' : `${n} changes need attention`} — fix or discard {n === 1 ? 'it' : 'them'}, then save again.
          </p>
        </div>
      </div>
      <ul className="mt-3 space-y-2">
        {problems.map((p, i) => (
          <li key={i} className="flex items-start gap-3 rounded-xl bg-canvas-elevated border border-glass-border px-3 py-2">
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] font-semibold text-ink truncate">{p.name}</p>
              <p className="text-[11.5px] text-rose-700 dark:text-rose-200/90 leading-snug mt-0.5">{p.reason}</p>
            </div>
            {p.changeIds.length > 0 && (
              <button
                type="button"
                onClick={() => onDiscard(p.changeIds)}
                className="flex-shrink-0 mt-0.5 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold text-rose-700 dark:text-rose-100 bg-rose-500/15 border border-rose-500/30 hover:bg-rose-500/25 transition-colors"
              >
                Discard this change
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

const MB = 1024 * 1024
/** "Saving…", or — a save too large for one request — how far it has got: its changes going up,
 *  then the server writing them as one commit. */
function SaveProgressLabel() {
  const p = useSaveProgressStore((s) => s.progress)
  if (!p) return <>Saving…</>
  if (p.phase === 'uploading') {
    const unit = p.total >= 10 * MB ? MB : 1024
    const n = (b: number) => (b / unit).toLocaleString(undefined, { maximumFractionDigits: unit === MB ? 0 : 1 })
    return <span className="tabular-nums" aria-live="polite">Uploading {n(p.sent)} of {n(p.total)} {unit === MB ? 'MB' : 'KB'}…</span>
  }
  return <span aria-live="polite">{p.phase === 'preparing' ? 'Preparing the save…' : 'Writing one commit…'}</span>
}
