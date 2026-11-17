/**
 * Review & Save — one guided place to take staged edits from the canvas to the draft, and on to
 * the Published version.
 *
 *   1. **Review** what will be saved, in words (List) or drawn (Map): one card per entity or
 *      relationship changed, each saying what it does ("Renamed orders to Orders v2") with only the
 *      fields the save sends, shown as the values they are. Undo / Redo, discard one, or all.
 *      What the draft already holds from earlier saves and imports is listed beneath.
 *   2. **Save** — to the draft (and keep editing; save as often as you like), or save and go
 *      straight on to publishing or to a review.
 *   3. **Publish** — the shared publish flow (`PublishForm`), its title taken from what was saved,
 *      over the whole draft, not just this batch. Offered only when there is something to publish;
 *      opened straight onto when nothing is staged but the draft has changes.
 *
 * Theme-aware (light and dark). A save or publish in flight holds the dialog: nothing in it is
 * closed, discarded or undone until it settles.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle, ArrowUpRight, Check, CheckCircle2, ChevronRight, CircleAlert, Code2, FileStack, GitPullRequest,
  Layers, ListTree, Loader2, Map as MapIcon, OctagonAlert, Rocket, Save, Search, Undo2, Redo2, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatShortcut } from '@/lib/platform'
import { useCanvasStore } from '@/store/canvas'
import { useBranchStore } from '@/store/branchStore'
import { usePersonaMode } from '@/store/persona'
import { usePermission } from '@/store/auth'
import { liveProblems, useSaveProblemsStore } from '@/store/saveProblemsStore'
import type { SaveProblem } from '@/features/versioning/model/saveProblems'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { Segmented } from '@/components/ui/Segmented'
import { useEntityColorSet } from '@/hooks/useEntityVisual'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'
import { nodeUpdatePatch } from '@/features/versioning/model/stagedChangesToOps'
import {
  buildReviewGroups, describeScope, fieldChanges, suggestTitle, type ReviewGroup, type Sentence,
} from '@/features/versioning/model/reviewModel'
import { fromChangeCounts } from '@/features/versioning/model/changeAdapters'
import { EMPTY_CHANGE_SET, type ChangeSet, type ChangeStatus } from '@/features/versioning/model/changeModel'
import { useChangeSummary, useDataSourceDraftsPolicy } from '@/features/versioning/hooks/useVersioning'
import { useActiveDraftAccess } from '@/features/versioning/hooks/useActiveDraftAccess'
import { CascadeImpactList } from '@/features/versioning/components/CascadeImpactList'
import { ConflictChoices } from '@/features/versioning/components/ConflictChoices'
import { ChangesPanel, ChangeCountChips } from '@/features/versioning/components/ChangesPanel'
import { STATUS_META } from '@/features/versioning/components/NodeDiffBadge'
import { ReviewValue } from '@/features/versioning/components/ReviewValue'
import { PublishActions, PublishBody, usePublishFlow } from '@/features/versioning/components/PublishForm'
import { JsonView } from '@/components/panels/shell/JsonView'

// Drawn only when the Map is opened: React Flow and the layout engine stay out of the first paint.
const ChangeMap = lazy(() => import('@/features/versioning/components/ChangeMap'))

/** Cards drawn before "Show more": a 5,000-change review opens as fast as a 5-change one. */
const GROUPS_SHOWN = 100
/** Up to this many cards open with their fields showing. */
const OPEN_FIRST = 20

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

const sentenceText = (s: Sentence) => s.map((p) => (typeof p === 'string' ? p : p.name)).join('')

function SentenceView({ sentence }: { sentence: Sentence }) {
  return (
    <>
      {sentence.map((p, i) => (typeof p === 'string'
        ? <span key={i}>{p}</span>
        : <span key={i} className="font-semibold text-ink">{p.name}</span>))}
    </>
  )
}

/** Names for ids and urns, as the canvas holds them — read once per review, never subscribed to. */
function canvasLookup() {
  let names: Map<string, { label: string; type?: string }> | null = null
  const index = () => {
    if (names) return names
    names = new Map()
    for (const n of useCanvasStore.getState().nodes) {
      const d = n.data as Record<string, unknown>
      const entry = { label: String(d.label ?? d.displayName ?? n.id), type: typeof d.type === 'string' ? d.type : undefined }
      names.set(n.id, entry)
      if (typeof d.urn === 'string') names.set(d.urn, entry)
    }
    return names
  }
  return {
    nameOf: (id: string) => index().get(id)?.label ?? id,
    typeOf: (id: string) => index().get(id)?.type,
  }
}

export function StagedChangesPanel({ onConfirm, describe, wsId, graphId, dataSourceId, viewId, onReveal }: SaveConfirmationModalProps) {
  const isOpen = useStagedChangesStore(s => s.isReviewPanelOpen)
  const close = useStagedChangesStore(s => s.closeReviewPanel)
  const intent = useStagedChangesStore(s => s.reviewIntent)
  const stagedChanges = useStagedChangesStore(s => s.changes)
  const changes = useMemo(() => (describe
    ? stagedChanges.map(c => { const now = describe(c); return now && now !== c.summary ? { ...c, summary: now } : c })
    : stagedChanges), [stagedChanges, describe])
  const discard = useStagedChangesStore(s => s.discard)
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
  const discardUnlessSaving = (id: string) => { if (!saving()) discard(id) }

  const draftCount = draftChanges ? draftChanges.counts.added + draftChanges.counts.modified + draftChanges.counts.removed : 0
  // Publishing needs the draft's graph; a host that gives none (or Published) only saves here.
  const canPublishHere = !!(wsId && graphId && branchId)

  const [step, setStep] = useState<'review' | 'publish'>('review')
  const [destination, setDestination] = useState<ReviewDestination>('draft')
  const [view, setView] = useState<'list' | 'map'>('list')
  const [filter, setFilter] = useState('')
  const [shown, setShown] = useState(GROUPS_SHOWN)
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [focusKey, setFocusKey] = useState<string | null>(null)
  /** What the last save carried, for the Publish step's title. */
  const [savedTitle, setSavedTitle] = useState('')
  const filterInputRef = useRef<HTMLInputElement>(null)

  // Each opening starts afresh: on the review — or, with nothing staged and a draft that has
  // changes, on Publish.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      const s = useStagedChangesStore.getState()
      setStep(s.changes.length === 0 && draftCount > 0 && canPublishHere ? 'publish' : 'review')
      setDestination(s.reviewIntent === 'publish' && canPublishHere ? 'publish' : 'draft')
      setView('list')
      setFilter('')
      setShown(GROUPS_SHOWN)
      setOpen(null)
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, closeUnlessSaving])

  const lookup = useMemo(() => canvasLookup(), [isOpen, changes]) // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => (isOpen ? buildReviewGroups(changes, lookup) : []), [isOpen, changes, lookup])
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return groups
    return groups.filter(g => g.name.toLowerCase().includes(q) || g.key.toLowerCase().includes(q)
      || g.changes.some(c => c.summary.toLowerCase().includes(q) || (c.targetUrn ?? '').toLowerCase().includes(q)))
  }, [groups, filter])
  const dataGroups = useMemo(() => filtered.filter(g => g.kind !== 'layout'), [filtered])
  const layoutGroups = useMemo(() => filtered.filter(g => g.kind === 'layout'), [filtered])
  const layoutCount = useMemo(() => groups.filter(g => g.kind === 'layout').length, [groups])
  const openKeys = useMemo(() => open ?? new Set(groups.slice(0, OPEN_FIRST).map(g => g.key)), [open, groups])
  const toggle = (key: string) => setOpen(() => {
    const next = new Set(openKeys)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const total = changes.length
  const failedCount = changes.filter(c => c.error).length
  // Why the last save was refused (nothing was written) — the problems still tied to staged changes.
  const allProblems = useSaveProblemsStore(s => s.problems)
  const problems = useMemo(
    () => liveProblems(allProblems, new Set(changes.map(c => c.id))),
    [allProblems, changes],
  )
  const counts = useMemo(() => {
    const out: Record<ChangeStatus, number> = { added: 0, modified: 0, removed: 0 }
    for (const g of groups) if (g.kind !== 'layout') out[g.status]++
    return out
  }, [groups])

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
  const showInList = (key: string) => {
    setView('list')
    setFilter('')
    setOpen(new Set([...openKeys, key]))
    setFocusKey(key)
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
              className="pointer-events-auto relative w-full max-w-[880px] max-h-[min(860px,100%)] flex flex-col rounded-3xl overflow-hidden bg-canvas-elevated border border-glass-border shadow-glass-lg"
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
                      {total}
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
                        ? 'Nothing pending. Make some edits and they’ll show up here for review.'
                        : <>You’re changing <span className="font-semibold text-ink">{describeScope(groups)}</span>. Nothing is saved until you choose below.</>}
                    {failedCount > 0 && problems.length === 0 && step === 'review' && (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-rose-600 dark:text-rose-400 font-semibold">
                        <AlertTriangle className="w-3 h-3" />
                        {failedCount} previously failed
                      </span>
                    )}
                  </p>
                </div>
              </div>

              <StepTrail step={step} destination={destination} canPublish={canPublishHere} />

              {step === 'review' && problems.length > 0 && (
                <SaveProblemsBanner problems={problems} onDiscard={(ids) => ids.forEach(discardUnlessSaving)} />
              )}

              {step === 'review' && total > 0 && (
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
                    value={view}
                    onChange={setView}
                    options={[{ value: 'list', label: 'List', icon: ListTree }, { value: 'map', label: 'Map', icon: MapIcon }]}
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

              {step === 'review' && view === 'list' && total > 4 && (
                <div className="relative mt-3">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                  <input
                    ref={filterInputRef}
                    type="text"
                    value={filter}
                    onChange={e => { setFilter(e.target.value); setShown(GROUPS_SHOWN) }}
                    placeholder="Filter changes by name or URN…"
                    className="w-full pl-9 pr-8 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[12px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-accent-lineage/50 transition-colors"
                  />
                  {filter && (
                    <button
                      onClick={() => setFilter('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                      aria-label="Clear filter"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
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
                  {groups.length === 0 ? (
                    <EmptyState hasFilter={false} onClearFilter={() => setFilter('')} />
                  ) : view === 'map' ? (
                    <Suspense fallback={<div className="h-[min(52vh,460px)] rounded-2xl border border-glass-border flex items-center justify-center text-xs text-ink-muted gap-2"><Loader2 className="w-4 h-4 animate-spin" />Drawing the map…</div>}>
                      <ChangeMap groups={groups} saved={draftChanges} nameOf={lookup.nameOf} onShowInList={showInList} onReveal={reveal} />
                    </Suspense>
                  ) : filtered.length === 0 ? (
                    <EmptyState hasFilter onClearFilter={() => setFilter('')} />
                  ) : (
                    <>
                      {/* Data-source changes — everything that commits to the graph. */}
                      {dataGroups.length > 0 && (
                        <section className="space-y-2">
                          {dataGroups.slice(0, shown).map(g => (
                            <GroupCard
                              key={`${g.kind}:${g.key}`}
                              group={g}
                              open={openKeys.has(g.key)}
                              focus={focusKey === g.key}
                              onToggle={() => toggle(g.key)}
                              onDiscard={(ids) => ids.forEach(discardUnlessSaving)}
                              onReveal={reveal}
                            />
                          ))}
                          {dataGroups.length > shown && (
                            <button onClick={() => setShown(n => n + GROUPS_SHOWN)}
                              className="w-full py-2 rounded-xl border border-dashed border-glass-border text-xs font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
                              Show {Math.min(GROUPS_SHOWN, dataGroups.length - shown)} more of {dataGroups.length - shown}
                            </button>
                          )}
                        </section>
                      )}

                      {/* View layout — presentation only, DECOUPLED from the data source. Own banner so it's
                          unmistakably not a data change; on Save it persists to the view, never the graph. */}
                      {layoutGroups.length > 0 && (
                        <section>
                          <div className={cn(
                            'flex items-center gap-2 px-1 mb-2',
                            dataGroups.length > 0 && 'pt-4 border-t border-glass-border',
                          )}>
                            <div className="w-6 h-6 rounded-md flex items-center justify-center border bg-indigo-500/[0.08] border-indigo-500/25">
                              <Layers className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-300" strokeWidth={2.2} />
                            </div>
                            <h4 className="text-[11px] font-bold uppercase tracking-[0.08em] text-indigo-700 dark:text-indigo-200">View layout</h4>
                            <span className="text-[10.5px] text-ink-muted font-medium hidden sm:inline">this view only · not the data source</span>
                            <span className="text-[10px] tabular-nums text-ink-muted font-semibold ml-auto">{layoutCount}</span>
                          </div>
                          <div className="space-y-1.5">
                            {layoutGroups.map(g => (
                              <GroupCard key={g.key} group={g} open={false} focus={false} onToggle={() => {}}
                                onDiscard={(ids) => ids.forEach(discardUnlessSaving)} />
                            ))}
                          </div>
                        </section>
                      )}
                    </>
                  )}

                  {draftChanges && draftCount > 0 && view === 'list' && (
                    <DraftSavedSection changeSet={draftChanges} />
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
                          if (confirm(`Discard all ${total} staged change${total === 1 ? '' : 's'}? This cannot be undone.`)) {
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
                            Saving…
                          </>
                        ) : destination === 'draft' || !canPublishHere ? (
                          <>
                            <Check className="w-4 h-4" strokeWidth={3} />
                            Save {total} change{total === 1 ? '' : 's'}
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

/** Review → Save → Publish, with where this review is in it. */
function StepTrail({ step, destination, canPublish }: { step: 'review' | 'publish'; destination: ReviewDestination; canPublish: boolean }) {
  const steps: { label: string; state: 'done' | 'current' | 'next' | 'optional' }[] = [
    { label: 'Review', state: step === 'review' ? 'current' : 'done' },
    { label: 'Save to draft', state: step === 'publish' ? 'done' : 'next' },
    {
      label: destination === 'review' ? 'Send for review' : 'Publish',
      state: step === 'publish' ? 'current' : destination === 'draft' ? 'optional' : 'next',
    },
  ]
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
      <span className="font-bold">{count}</span>
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

function EmptyState({ hasFilter, onClearFilter }: { hasFilter: boolean; onClearFilter: () => void }) {
  return (
    <div className="px-4 py-14 text-center flex flex-col items-center gap-3">
      <div className="w-14 h-14 rounded-2xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border flex items-center justify-center">
        <CheckCircle2 className="w-7 h-7 text-ink-muted" strokeWidth={1.6} />
      </div>
      <div>
        <p className="text-sm text-ink font-semibold">
          {hasFilter ? 'No changes match your filter' : 'No staged changes'}
        </p>
        <p className="text-[12px] text-ink-muted mt-1 max-w-[420px] leading-relaxed">
          {hasFilter
            ? 'Try a different search, or clear the filter to see everything pending.'
            : 'Edit a value on the canvas or in an entity’s details — it shows up here, ready to save.'}
        </p>
      </div>
      {hasFilter && (
        <button
          onClick={onClearFilter}
          className="mt-1 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
        >
          Clear filter
        </button>
      )}
    </div>
  )
}

/** One thing changed — an entity, a relationship, a layout item — and what each change does to it. */
function GroupCard({ group, open, focus, onToggle, onDiscard, onReveal }: {
  group: ReviewGroup
  open: boolean
  focus: boolean
  onToggle: () => void
  onDiscard: (ids: string[]) => void
  onReveal?: (nodeId: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (focus) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [focus])
  const meta = STATUS_META[group.status]
  const colors = useEntityColorSet(group.typeId ?? '')
  const sentence = sentenceText(group.sentence)
  const layout = group.kind === 'layout'
  const error = group.changes.find(c => c.error)?.error
  const n = group.changes.length
  return (
    <div
      ref={ref}
      className={cn(
        'group rounded-2xl border bg-canvas-elevated transition-shadow border-l-[3px]',
        error ? 'border-rose-500/50 bg-rose-500/[0.04]' : 'border-glass-border hover:shadow-sm',
        layout ? 'border-l-indigo-500' : meta.accent,
        focus && 'ring-2 ring-accent-lineage/40',
      )}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        {!layout ? (
          <button
            onClick={onToggle}
            className="mt-0.5 p-0.5 rounded text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] flex-shrink-0"
            aria-label={open ? 'Collapse' : 'Expand'}
            aria-expanded={open}
          >
            <ChevronRight className={cn('w-3.5 h-3.5 transition-transform duration-150', open && 'rotate-90')} />
          </button>
        ) : <span className="w-[18px]" />}
        <div className="flex-1 min-w-0">
          {layout ? (
            <p className="text-[13px] font-medium text-ink leading-snug">{sentence}</p>
          ) : (
            <>
              <div className="flex items-center gap-2 min-w-0">
                {group.kind === 'node' && (
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: group.typeId ? colors.hex : undefined }} aria-hidden />
                )}
                <span className="text-[13px] font-semibold text-ink truncate">{group.name}</span>
                <span className={cn('px-1.5 py-px rounded text-[9.5px] font-bold uppercase tracking-wide flex-shrink-0', meta.bg, meta.text)}>
                  {group.kind === 'edge' ? `${meta.label} link` : meta.label}
                </span>
                {n > 1 && <span className="text-[10.5px] text-ink-muted flex-shrink-0">{n} changes</span>}
              </div>
              {sentence !== group.name && (
                <p className="text-[12px] text-ink-secondary mt-0.5 leading-snug"><SentenceView sentence={group.sentence} /></p>
              )}
            </>
          )}
          {group.changes.some(c => c.targetUrn && c.targetUrn !== c.targetId) && !layout && (
            <p className="text-[10.5px] text-ink-muted mt-0.5 font-mono truncate">{group.changes[0].targetUrn}</p>
          )}
          {error && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] leading-snug text-rose-700 dark:text-rose-300">
              <CircleAlert className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden />
              <span><span className="font-semibold">Not saved — </span>{error}</span>
            </p>
          )}
          {group.changes.map(c => c.conflict && <ConflictChoices key={c.id} change={c} />)}

          <AnimatePresence initial={false}>
            {open && !layout && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="mt-2 space-y-2">
                  {group.changes.map(c => <ChangeDetail key={c.id} change={c} several={n > 1} />)}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onReveal && group.revealId && (
            <HoverTip label="Show on the canvas" className="inline-flex">
              <button
                onClick={() => onReveal(group.revealId!)}
                className="p-1.5 rounded-md text-ink-muted hover:text-accent-lineage hover:bg-accent-lineage/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                aria-label="Show on canvas"
              >
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </HoverTip>
          )}
          <HoverTip label={n === 1 ? 'Discard this change' : `Discard these ${n} changes`} detail="Redo brings it back" className="inline-flex">
            <button
              onClick={() => onDiscard(group.changes.map(c => c.id))}
              className="p-1.5 rounded-md text-ink-muted hover:text-rose-600 dark:hover:text-rose-300 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
              aria-label={n === 1 ? 'Discard change' : `Discard ${n} changes`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </HoverTip>
        </div>
      </div>
    </div>
  )
}

/** One change's detail: its fields as values, a move's from/to, a delete's cascade. */
function ChangeDetail({ change, several }: { change: StagedChange; several: boolean }) {
  const technical = usePersonaMode() === 'technical'
  const [json, setJson] = useState(false)
  const fields = useMemo(() => fieldChanges(change), [change])
  const cascade = change.type === 'delete_entity' ? (change.before as { cascade?: Parameters<typeof CascadeImpactList>[0]['impact'] } | undefined)?.cascade : undefined
  // What the save sends — the patch, never the whole node twice.
  const patch = useMemo(() => {
    if (!json) return null
    if (change.type === 'update_entity' || change.type === 'rename_entity') {
      const { payload, unset } = nodeUpdatePatch(change.before, change.after)
      return unset.length ? { ...payload, unsetProperties: unset } : payload
    }
    return { before: change.before ?? null, after: change.after ?? null }
  }, [json, change])

  let body: ReactNode = null
  if (change.type === 'move_entity') body = <MoveDetail change={change} />
  else if (cascade) body = <CascadeImpactList impact={cascade} rootUrn={change.targetUrn} />
  else if (fields.length > 0) {
    body = (
      <div className="rounded-xl border border-glass-border overflow-hidden bg-black/[0.015] dark:bg-white/[0.02]">
        {fields.map((f, i) => <ReviewValue key={`${f.folder ?? ''}/${f.label}/${i}`} field={f} />)}
      </div>
    )
  }
  if (!body && !several && !technical) return null
  return (
    <div className="space-y-1.5">
      {several && <p className="text-[11px] text-ink-muted">{change.summary}</p>}
      {body}
      {technical && (
        <div>
          <button type="button" onClick={() => setJson(v => !v)}
            className="inline-flex items-center gap-1 text-[10.5px] font-medium text-ink-muted hover:text-ink">
            <Code2 className="w-3 h-3" aria-hidden />{json ? 'Hide technical details' : 'Technical details'}
          </button>
          {json && patch && <div className="mt-1"><JsonView data={patch} label="What the save sends" /></div>}
        </div>
      )}
    </div>
  )
}

/** A move, in words: where the entity sits now and where the save puts it. (Its raw `before` holds
 *  the undo state — the whole view layout — which is no reading matter.) */
function MoveDetail({ change }: { change: StagedChange }) {
  const nodes = useCanvasStore(s => s.nodes)
  const label = (id: string | null | undefined) =>
    id ? ((nodes.find(n => n.id === id)?.data?.label as string | undefined) ?? id) : null
  const after = change.after as { parentId?: string | null; edgeType?: string | null }
  const removed = ((change.before as { removedLinks?: Array<{ source: string }> } | undefined)?.removedLinks ?? [])
  const from = [...new Set(removed.map(e => label(e.source)))].filter(Boolean).join(', ')
  const cell = (title: string, value: string, hint?: string) => (
    <div className="rounded-lg border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] p-2 min-w-0">
      <p className="text-[9px] uppercase tracking-[0.08em] text-ink-muted mb-1 font-bold">{title}</p>
      <p className="text-[12px] text-ink break-words">{value}</p>
      {hint && <p className="text-[10.5px] text-ink-muted mt-0.5">{hint}</p>}
    </div>
  )
  return (
    <div className="grid grid-cols-2 gap-2">
      {cell('From', from || 'Its current parent', from ? undefined : 'Replaced on save, wherever it is')}
      {cell('To', label(after.parentId) ?? 'Top level', after.edgeType ? `as ${after.edgeType}` : undefined)}
    </div>
  )
}

/** What the draft already holds from earlier saves and imports — what publishing takes along too. */
function DraftSavedSection({ changeSet }: { changeSet: ChangeSet }) {
  const [open, setOpen] = useState(false)
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
          <ChangesPanel changeSet={changeSet} emptyHint="Nothing saved on this draft yet." />
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
                on ? 'border-accent-lineage/60 bg-accent-lineage/[0.07] ring-1 ring-accent-lineage/30' : 'border-glass-border hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
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
