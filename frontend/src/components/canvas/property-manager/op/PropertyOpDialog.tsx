/**
 * PropertyOpDialog — one bulk property change, guided: **What** (the operation, the property, its
 * value or new name — or how a clean-up tidies its values, with a before → after) → **Where**
 * (which entities) → **Review** (counted exactly, with anything that would stop it, and an optional
 * reason kept with it), then applied to the draft by a job on the server: every entity the target
 * reaches, however many — not only the ones loaded on the canvas. Relationships the same way: named
 * ones, or every one a Connections search matches (an edge target, `isEdgeTarget`).
 *
 * It is applied only once Review's count is final. A removal, a rename or an overwrite of many
 * entities (or across the whole data source) asks for the property's name to be typed first — of
 * any number, when the count is approximate or unknown. The request carries a key made from what it
 * applies, so retrying after a failure never applies it twice. Another change still running on
 * the draft can be followed from here instead. Portal-mounted: a scrim beside an inert wrapper,
 * only the panel interactive; a body that fails to draw offers to close it.
 *
 * About 768px wide, and the whole screen on a phone. Its title says what it does: "Add a property"
 * gives a value to one nothing in the view holds yet. Each step in the rail says what was chosen
 * there. A step slides in from the side it is travelled to, and the focus goes into it and stays in
 * the dialog, so Esc and ⌘↵ work wherever it opens.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useIsPresent, type Variants } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, Database, X } from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button, IconButton } from '@/components/ui/Button'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import { useAppNotifications } from '@/components/ui/notifications'
import { PanelErrorBoundary } from '@/components/panels/PanelErrorBoundary'
import { usePropertyCatalog } from '@/hooks/usePropertyCatalog'
import {
  JobActiveError, PropertyJobRefusedError, createPropertyJob, getPropertyJob, previewPropertyJob, previewPropertyJobSample,
  type PropertyJob, type PropertyJobOp, type PropertyJobPreview, type PropertyJobSample,
} from '@/services/versioningApiService'
import type { SearchCatalogProperty } from '@/types/search'
import { useDiscovery } from '../../search/builder/useDiscovery'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { jobEnded, useDraftPropertyJobs, usePropertyJobsStore, type OpRequest } from '@/store/propertyJobsStore'
import {
  EDGE_RESERVED_KEYS, applyLabel, impactOf, isCleanup, isEdgeTarget, jobOp, needsTypedConfirm, needsValue, opProblem, predicateOf,
  propertyJobLabel, reviewCounts, scopeFixedToView, scopedTargetLabel, sentence, targetOf, tooManyIds, type OpDraft, type ScopeMode, type TargetPreset,
} from './opModel'
import { SECONDARY_EDGE } from './styles'
import { useReviewCounts } from './useReviewCounts'
import { entityTypesOf } from './fillRequired'
import { WhatStep } from './WhatStep'
import { WhereStep, type LayerOption } from './WhereStep'
import { ReviewStep } from './ReviewStep'

export interface GraphWrite { wsId: string; graphId: string; branchId: string }

const STEPS = ['What', 'Where', 'Review'] as const

/** A step comes in from the side it is travelled to, and leaves by the other. */
const SLIDE: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: 24 * dir }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: -24 * dir }),
}

export function PropertyOpDialog({
  viewId, graphWrite, seed, knownEntityTypes, layers, selectionIds, onClose, onOpenManager,
}: {
  viewId: string
  graphWrite: GraphWrite
  seed: OpRequest
  knownEntityTypes: string[]
  layers: readonly LayerOption[]
  selectionIds: readonly string[]
  onClose: () => void
  /** Open Property Manager, where the draft's changes are followed. */
  onOpenManager?: () => void
}) {
  const { notify } = useAppNotifications()
  const { catalog } = usePropertyCatalog(viewId)
  const properties = useMemo(() => catalog?.properties ?? [], [catalog])

  const [op, setOp] = useState<OpDraft>(() => ({
    kind: seed.kind ?? 'set', key: seed.key ?? '', to: '', value: '', onConflict: 'skip',
    ...(seed.map ? { map: seed.map } : {}), ...(seed.toKind ? { toKind: seed.toKind } : {}), ...seed.op,
  }))
  // The target chosen — the one it was opened with, or one picked on Where — kept apart from the
  // default, which is worked out afresh as the property and the catalog change (below).
  const [chosen, setChosen] = useState<TargetPreset | null>(() => seed.target ?? null)
  const [scopeMode, setScopeMode] = useState<ScopeMode>(() => (seed.target?.kind === 'search' || seed.target?.kind === 'connections' ? seed.target.scopeMode : seed.scopeMode ?? 'view'))
  const [sourceConfirmed, setSourceConfirmed] = useState(false)
  // Relationships, not entities (`EdgeWhatStep`): only ever the target it was opened with.
  const edges = !!chosen && isEdgeTarget(chosen)
  // A change whose What is already whole (Remove from a row) opens on Where; a clean-up opens on
  // What, where its before → after is shown.
  const [step, setStep] = useState(() => (isCleanup(op.kind) || opProblem(op, !!seed.target && isEdgeTarget(seed.target)) ? 0 : 1))
  // Which way the last step change went: 1 forward, -1 back.
  const [dir, setDir] = useState(1)
  const go = (to: number) => { setDir(to < step ? -1 : 1); setStep(to) }
  const [reason, setReason] = useState('')
  const cleanup = isCleanup(op.kind)
  // The keys the view's relationships carry, for a change of relationships.
  const { keysByEdgeType } = useDiscovery(edges ? viewId : null)
  const edgeProperties = useMemo(() => edgePropertiesOf(keysByEdgeType), [keysByEdgeType])
  // "Add a property" gives a value to a property nothing in the view holds yet, or to one not named
  // yet (Property Manager's New). Until the catalog answers, a named property counts as held.
  const key = op.key.trim()
  const held = !!key && (edges ? edgeProperties.some((p) => p.key === key) : !catalog || properties.some((p) => p.key === key))
  // Unless one is chosen, a change reaches every entity in the view when nothing holds its property
  // yet — the catalog read to the end, and no change on this draft still adding it — and otherwise
  // every entity with it. A target that names the property follows it as it is renamed on What.
  const adding = useDraftPropertyJobs(graphWrite.graphId, graphWrite.branchId)
    .some((t) => !jobEnded(t) && t.entityKind !== 'edge' && writesKey(t.op, key))
  const nothingHolds = !key || (catalog?.status === 'complete' && !properties.some((p) => p.key === key) && !adding)
  const preset: TargetPreset = chosen?.kind === 'hasKey' ? { kind: 'hasKey', key }
    : chosen ?? (nothingHolds ? { kind: 'view' } : { kind: 'hasKey', key })
  const title = cleanup ? 'Clean up a property' : needsValue(op.kind) && !held ? 'Add a property' : 'Change a property'
  // Opened with its property named (a fill from a refused publish, a catalog row): What focuses
  // what is still to give. And the target it was opened with, said on What when it has a name.
  const keySeeded = !!(seed.op?.key ?? seed.key)
  const seededFor = seed.target && 'label' in seed.target && seed.target.label ? scopedTargetLabel(preset, scopeMode) : null
  // A reusable change run as it was kept has nothing new to keep.
  const [openedAs] = useState(() => JSON.stringify([jobOp(op), preset, scopeMode]))
  const unchangedReusable = !!seed.reusable && JSON.stringify([jobOp(op), preset, scopeMode]) === openedAs

  // ── Where ──
  const target = targetOf(preset, viewId, scopeMode)
  const predicate = predicateOf(preset)
  const effectiveScope: ScopeMode = scopeFixedToView(preset) ? 'view' : scopeMode
  const whatProblem = opProblem(op, edges)
  const whereProblem = !target
    ? (tooManyIds(preset) ? (edges ? 'Pick fewer relationships' : 'Choose fewer, or another target')
      : preset.kind === 'custom' ? 'Add a condition to say which entities' : `Choose which ${edges ? 'relationships' : 'entities'}`)
    : preset.kind !== 'selection' && preset.kind !== 'relationships' && effectiveScope === 'data_source' && !sourceConfirmed ? 'Confirm the whole data source is meant' : null

  // ── Review: counted, checked and sampled once it is reached ──
  const reviewing = step === 2 && !whatProblem && !whereProblem
  // Try again: the check and the counts asked afresh.
  const [attempt, setAttempt] = useState(0)
  const retry = () => setAttempt((n) => n + 1)
  const countItems = useMemo(() => (reviewing && predicate ? reviewCounts(op, predicate) : null), [reviewing, predicate, op])
  const counts = useReviewCounts(viewId, countItems, effectiveScope, attempt)
  // The server's check, kept with the request it answers: a newer request reads as checking.
  const changeKey = reviewing && target ? JSON.stringify({ op: jobOp(op), target }) : ''
  const requestKey = changeKey && `${changeKey}#${attempt}`
  const [checked, setChecked] = useState<{ key: string; data: PropertyJobPreview | null; error: string | null }>({ key: '', data: null, error: null })
  useEffect(() => {
    if (!requestKey || !target) return
    const controller = new AbortController()
    previewPropertyJob(graphWrite.wsId, graphWrite.graphId, graphWrite.branchId, jobOp(op), target, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setChecked({ key: requestKey, data, error: null }) })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setChecked({ key: requestKey, data: null, error: (e as Error).message || 'the server didn’t answer' })
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, graphWrite.wsId, graphWrite.graphId, graphWrite.branchId])
  const answered = checked.key === requestKey
  const preview = { data: answered ? checked.data : null, error: answered ? checked.error : null, loading: !!requestKey && !answered }
  // A few of the entities it reaches, before and after: asked apart from the check, so Apply never
  // waits on it — again with each request, and alone by its own Try again.
  const [sampleAttempt, setSampleAttempt] = useState(0)
  const sampleKey = requestKey && `${requestKey}~${sampleAttempt}`
  const [sampled, setSampled] = useState<{ key: string; data: PropertyJobSample | null; error: string | null }>({ key: '', data: null, error: null })
  useEffect(() => {
    if (!sampleKey || !target) return
    const controller = new AbortController()
    previewPropertyJobSample(graphWrite.wsId, graphWrite.graphId, graphWrite.branchId, jobOp(op), target, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setSampled({ key: sampleKey, data, error: null }) })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setSampled({ key: sampleKey, data: null, error: (e as Error).message || 'the server didn’t answer' })
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleKey, graphWrite.wsId, graphWrite.graphId, graphWrite.branchId])
  const sampleAnswered = sampled.key === sampleKey

  const ids = preset.kind === 'selection' || preset.kind === 'relationships'
  const tally = ids
    ? preview.data?.counts ? {
      target: preview.data.counts.matched, haveKey: preview.data.counts.haveKey, haveTo: preview.data.counts.haveTo ?? 0,
      wouldChange: preview.data.counts.wouldChange,
    } : null
    : counts.counts.size > 0 ? {
      target: counts.counts.get('target')?.count, haveKey: counts.counts.get('haveKey')?.count, haveTo: counts.counts.get('haveTo')?.count,
      match: counts.counts.get('match')?.count,
    } : null
  // A convert's bound, from how the view's entities store the property (the target is in the view).
  const kinds = effectiveScope === 'view' ? properties.find((p) => p.key === op.key.trim())?.kinds : null
  const impact = tally && tally.target !== undefined ? impactOf(op, tally, kinds) : null
  // Counted to the end (or, where nothing can count it, never to be); `exact` when it is also the
  // draft's own count, not Published's or a floor.
  const final = ids ? !!preview.data?.counts : counts.complete || counts.unavailable
  const exact = final && (ids || ![...counts.counts.values()].some((c) => c.approximate || c.lowerBound))
  const stagedCount = useStagedChangesStore((s) => s.changes.length)
  // How many entities the draft has changed already, when it's the draft the change is made on.
  const draftChanges = useBranchStore((s) => {
    const c = s.currentBranchId === graphWrite.branchId ? s.activeChangeSet?.counts : null
    return c ? c.added + c.modified + c.removed : undefined
  })
  // Applied only on a final count: what it says it changes is what it changes. Why not, said by Apply.
  const blockedReason = stagedCount > 0 ? 'Save or discard your staged changes first'
    : preview.data?.activeJobId ? 'Another change is running on this draft'
      : preview.data?.refusal ? 'The server won’t apply it — see why above'
        : preview.data?.nameBudget?.verdict === 'refused' ? 'No room for a new property name — reuse one'
          : preview.error ? 'Couldn’t check it can be applied — try again'
            : !ids && counts.error ? 'The count stopped — try again'
              : preview.loading ? 'Checking it can be applied…'
                : !final ? 'Waiting for the count to finish'
                  : exact && impact?.changes === 0 ? 'Nothing would change'
                    : null
  const blocked = !!blockedReason

  // ── Apply ──
  // The same change sent again — a retry — carries the same key; a different one, a new key.
  const salt = useMemo(() => generateId('propjob'), [])
  const idempotencyKey = `${salt}:${hash(changeKey)}`
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [confirming, setConfirming] = useState(false)
  const submit = async () => {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      // The reason, when one is given, is the change's message: in the draft's history, and in the
      // audit of the publish that takes it to Published.
      const job = await createPropertyJob(graphWrite.wsId, graphWrite.graphId, graphWrite.branchId, jobOp(op), target, idempotencyKey,
        reason.trim() || `Bulk property: ${propertyJobLabel(jobOp(op))} on ${scopedTargetLabel(preset, effectiveScope)}`)
      usePropertyJobsStore.getState().track({
        jobId: job.jobId, ...graphWrite, viewId, op: jobOp(op), targetLabel: scopedTargetLabel(preset, effectiveScope),
        ...(edges ? { entityKind: 'edge' as const } : {}), startedAt: new Date().toISOString(), job,
      })
      notify('success', `Applying ${propertyJobLabel(jobOp(op))} to ${scopedTargetLabel(preset, effectiveScope)} on your draft — follow it in Property Manager.`)
      onClose()
    } catch (e) {
      setError(e instanceof Error && e.message ? e : new Error('The change could not be started. Try again.'))
    } finally {
      setSubmitting(false)
    }
  }
  // The change already running on the draft: followed in Property Manager, instead of this one.
  const follow = async (jobId: string) => {
    try {
      const job = await getPropertyJob(graphWrite.wsId, graphWrite.graphId, jobId)
      if (!job.op) throw new Error('it isn’t a bulk property change')
      usePropertyJobsStore.getState().track({
        jobId, ...graphWrite, viewId, op: job.op, targetLabel: startedOn(job),
        ...(job.entityKind === 'edge' ? { entityKind: 'edge' as const } : {}), startedAt: job.createdAt ?? new Date().toISOString(), job,
      })
      onClose()
      onOpenManager?.()
    } catch (e) {
      notify('error', `Couldn’t follow it: ${(e as Error).message}. An import shows in the draft’s history once it ends — apply this change after it.`)
    }
  }
  const apply = () => {
    if (needsTypedConfirm(op, impact, effectiveScope, exact)) setConfirming(true)
    else void submit()
  }

  const canNext = step === 0 ? !whatProblem : step === 1 ? !whereProblem : !blocked && !submitting
  // Starting was refused for another change running: following it is the way on.
  const jobActive = error instanceof JobActiveError ? error : null
  const next = () => {
    if (!canNext) return
    if (step < 2) go(step + 1)
    else apply()
  }

  // What each step has chosen, in a line: the change, where it reaches, how many it changes.
  const noun = edges ? 'relationships' : 'entities'
  const given = needsValue(op.kind) && op.value !== '' && op.value !== undefined ? ` = ${String(op.value)}` : ''
  const summaries = [
    key ? `${propertyJobLabel(jobOp(op))}${given}` : 'Not chosen yet',
    sentence(scopedTargetLabel(preset, effectiveScope)),
    !reviewing ? 'Not counted yet'
      : impact ? `${!final ? '' : impact.upTo ? 'at most ' : exact ? '' : 'about '}${impact.changes.toLocaleString()}${final ? '' : '+'} ${noun}`
        : !ids && counts.unavailable ? 'Counted as it runs' : 'Counting…',
  ]

  // On opening and at each step the focus goes into the step: to the choice made there, or its first
  // control, unless the step has put it on one of its own. The step stays scrolled to its top. Tab
  // then stays in the dialog.
  const panel = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
    const pane = body.current?.querySelector<HTMLElement>(`[data-step="${step}"]`)
    if (pane?.contains(document.activeElement)) return
    const target = pane && (pane.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? focusables(pane)[0])
    ;(target ?? panel.current)?.focus({ preventScroll: true })
  }, [step])
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || confirming) return
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); next() }
    else if (e.key === 'Tab' && panel.current) {
      const all = focusables(panel.current)
      const at = document.activeElement
      if (e.shiftKey ? at === all[0] || at === panel.current : at === all.at(-1)) {
        e.preventDefault()
        ;(e.shiftKey ? all.at(-1) : all[0])?.focus()
      }
    }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      <Backdrop open onClick={onClose} zClassName="z-[80]" className="bg-black/50" />
      <div className="fixed inset-0 z-[80] flex items-center justify-center sm:p-4 pointer-events-none" onKeyDown={onKeyDown}>
        <motion.div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby="property-op-title"
          tabIndex={-1}
          initial={{ opacity: 0, scale: 0.96, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={MOTION.modalSpring}
          // The whole screen on a phone. Wider, it keeps one height from step to step (as tall as the
          // room allows, up to 45rem), which leaves the property list room to open.
          className={cn('pointer-events-auto relative flex h-full w-full flex-col overflow-hidden bg-canvas-elevated shadow-2xl shadow-black/40 outline-none',
            'sm:h-auto sm:max-h-[90vh] sm:min-h-[min(45rem,90vh)] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-glass-border')}
        >
          <div className="shrink-0 border-b border-glass-border bg-gradient-to-br from-accent-lineage/[0.07] to-transparent px-5 pb-4 pt-5 sm:px-8 sm:pt-6">
            <div className="flex items-start gap-4">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-lineage/15 text-accent-lineage">
                <Database className="h-6 w-6" aria-hidden />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <h3 id="property-op-title" className="font-display text-xl font-semibold leading-tight text-ink">{title}</h3>
                <p className="mt-1 text-sm text-ink-muted">
                  {cleanup ? 'Tidy the values it holds on' : 'On'} every {edges ? 'relationship' : 'entity'} it should reach — applied to your draft by the server.
                </p>
                {seed.reusable && (
                  <p className="mt-1 break-words text-sm text-ink-secondary">From reusable change: <span className="font-semibold">{seed.reusable.name}</span></p>
                )}
                {step === 0 && seededFor && (
                  <p className="mt-1 break-words text-sm text-ink-secondary">For: <span className="font-semibold">{seededFor}</span></p>
                )}
              </div>
              <IconButton icon={X} label="Close" shortcut="Esc" onClick={onClose} />
            </div>
            <ol className="mt-5 grid grid-cols-3 gap-2" aria-label="Steps">
              {STEPS.map((label, i) => {
                const done = i < step
                const reachable = i < step || (i === 1 && !whatProblem) || (i === 2 && !whatProblem && !whereProblem)
                return (
                  <li key={label} className="min-w-0">
                    <button type="button" disabled={!reachable} onClick={() => go(i)} aria-current={i === step ? 'step' : undefined}
                      className={cn('flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                        i === step ? 'border-accent-lineage/50 bg-accent-lineage/[0.08]'
                          : cn('border-black/[0.07] dark:border-white/[0.08]', reachable ? 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]' : 'opacity-60'))}>
                      <span className={cn('mt-px hidden h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold sm:inline-flex',
                        i === step ? 'bg-accent-lineage text-white' : done ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/[0.06] text-ink-muted dark:bg-white/10')}>
                        {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-ink">{label}</span>
                        <span className="block truncate text-xs text-ink-muted">{summaries[i]}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>

          <div ref={body} className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar px-5 py-5 sm:px-8 sm:py-6">
            <PanelErrorBoundary resetKeys={[step]} onClose={onClose}>
              <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                <StepPane key={step} step={step} dir={dir}>
                  {step === 0 && (edges
                    ? <WhatStep op={op} onChange={setOp} properties={edgeProperties} viewId={viewId} edges />
                    : <WhatStep op={op} onChange={setOp} properties={properties} viewId={viewId}
                      entityTypes={entityTypesOf(preset) ?? knownEntityTypes} keySeeded={keySeeded} />)}
                  {step === 1 && (
                    <WhereStep
                      viewId={viewId} preset={preset} onPreset={setChosen} scopeMode={scopeMode} onScope={setScopeMode}
                      sourceConfirmed={sourceConfirmed} onConfirmSource={setSourceConfirmed} op={op}
                      selectionIds={selectionIds} layers={layers} seed={seed.target} knownEntityTypes={knownEntityTypes}
                    />
                  )}
                  {step === 2 && (
                    <ReviewStep
                      op={op} preset={preset} scopeMode={effectiveScope} counts={ids ? null : counts} impact={impact} exact={exact}
                      preview={preview.data} previewLoading={preview.loading} previewError={preview.error} onRetry={retry}
                      sample={sampleAnswered ? sampled.data : null} sampleLoading={!!sampleKey && !sampleAnswered}
                      sampleError={sampleAnswered ? sampled.error : null} onRetrySample={() => setSampleAttempt((n) => n + 1)}
                      stagedCount={stagedCount} draftChanges={draftChanges} reason={reason} onReason={setReason} edges={edges}
                      onFollow={(jobId) => void follow(jobId)} onChangeTarget={() => go(1)} offerSave={!unchangedReusable}
                    />
                  )}
                </StepPane>
              </AnimatePresence>
            </PanelErrorBoundary>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-glass-border bg-black/[0.02] px-5 py-4 dark:bg-white/[0.02] sm:flex-nowrap sm:px-8">
            <span role={error ? 'alert' : undefined} className={cn('min-w-0 basis-full text-sm empty:hidden sm:basis-0 sm:flex-1 sm:truncate',
              error ? 'text-rose-600 dark:text-rose-400' : 'text-ink-muted')}>
              {error?.message ?? (step === 0 ? whatProblem : step === 1 ? whereProblem : blockedReason) ?? ''}
            </span>
            {error instanceof PropertyJobRefusedError && error.code === 'too_many_ids' && (
              <Button size="md" variant="ghost" onClick={() => { setError(null); go(1) }}>Choose another target</Button>
            )}
            {step > 0 && <Button size="md" variant="ghost" leftIcon={ArrowLeft} onClick={() => go(step - 1)}>Back</Button>}
            <Button size="md" variant={jobActive ? 'secondary' : step === 2 && (op.kind === 'remove') ? 'danger' : 'primary'}
              className={cn(jobActive && SECONDARY_EDGE)} rightIcon={step < 2 ? ArrowRight : undefined}
              disabled={!canNext} loading={submitting} onClick={next}>
              {step < 2 ? 'Next' : error ? 'Try again' : applyLabel(impact, final, exact)}
            </Button>
            {jobActive && <Button size="md" variant="primary" onClick={() => void follow(jobActive.jobId)}>Follow it</Button>}
          </div>
        </motion.div>
      </div>
      {confirming && (
        <DangerConfirmDialog
          isOpen
          title={`${propertyJobLabel(jobOp(op))} on ${impact ? `${exact ? '' : 'about '}${impact.changes.toLocaleString()}` : 'an unknown number of'} ${edges ? 'relationships' : 'entities'}?`}
          subtitle={`On ${scopedTargetLabel(preset, effectiveScope)} — in your draft, until it is published.`}
          confirmPhrase={op.key.trim()}
          confirmLabel="Apply"
          icon={Database}
          busyLabel="Starting…"
          impactUnknown={!impact}
          unknownMessage="It can’t be counted here, so it may change more than you expect. Continue only if you are sure."
          sections={[{
            label: edges ? 'relationships' : 'entities', count: impact?.changes ?? 0,
            tone: op.kind === 'remove' || (op.kind === 'convert' && op.onFail === 'remove') ? 'destructive' : 'warning',
            consequence: op.kind === 'remove' ? `Lose ${op.key.trim()}` : op.kind === 'rename' ? `${op.key.trim()} becomes ${op.to.trim()}`
              : cleanup ? `${op.key.trim()} is rewritten${op.kind === 'convert' && op.onFail === 'remove' ? ', or removed where it won’t convert' : ''}`
                : `${op.key.trim()} is replaced`,
          }]}
          impactHeading="This will change"
          irreversibleNote={null}
          caveat="Nothing is published until the draft is. Until then, the draft's changes can be reviewed and discarded."
          onClose={() => setConfirming(false)}
          onConfirm={async () => { setConfirming(false); await submit() }}
        />
      )}
    </>,
    document.body,
  )
}

/** A step, sliding in from the side it is travelled to. As it leaves it can't be reached or read. */
function StepPane({ step, dir, children, ref }: { step: number; dir: number; children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  const present = useIsPresent()
  return (
    <motion.div ref={ref} data-step={step} custom={dir} variants={SLIDE} initial="enter" animate="center" exit="exit" transition={MOTION.stepSwap}>
      <div inert={!present} aria-hidden={present ? undefined : true}>{children}</div>
    </motion.div>
  )
}

/** The controls Tab reaches inside `root`, in order, leaving out those of a step on its way out. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]')]
    .filter((el) => el.tabIndex >= 0 && !el.closest('[inert]'))
}

/** The keys the view's relationships carry, as the What step names a property from — the ones most
 *  relationship types carry first (`count`: how many types do). An edge's own fields are not offered. */
function edgePropertiesOf(keysByEdgeType: Record<string, string[]>): SearchCatalogProperty[] {
  const types = new Map<string, number>()
  for (const keys of Object.values(keysByEdgeType)) {
    for (const k of keys) if (!EDGE_RESERVED_KEYS.has(k)) types.set(k, (types.get(k) ?? 0) + 1)
  }
  return [...types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]): SearchCatalogProperty => ({
      key, count, distinct: 0, distinctExact: false, values: [], byEntityType: {}, kinds: {}, residual: 0,
    }))
}

/** Whether a change gives entities `key`: set or filled, or renamed or copied onto it. */
function writesKey(op: PropertyJobOp, key: string): boolean {
  return op.kind === 'set' || op.kind === 'fillEmpty' ? op.key === key : (op.kind === 'rename' || op.kind === 'copy') && op.to === key
}

/** What a change started elsewhere was started on, in words. */
function startedOn(job: PropertyJob): string {
  const noun = job.entityKind === 'edge' ? 'relationships' : 'entities'
  if (job.target?.kind === 'ids') return job.target.count ? `${job.target.count.toLocaleString()} named ${noun}` : `named ${noun}`
  return `the ${noun} a search matches${job.target?.kind === 'predicate' && job.target.scopeMode === 'data_source' ? ', across the data source' : ''}`
}

/** A short, stable digest of what a request applies. */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
