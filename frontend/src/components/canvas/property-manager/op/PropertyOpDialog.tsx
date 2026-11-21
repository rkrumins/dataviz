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
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, Check, Database, X } from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button, IconButton } from '@/components/ui/Button'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import { useAppNotifications } from '@/components/ui/notifications'
import { PanelErrorBoundary } from '@/components/panels/PanelErrorBoundary'
import { usePropertyCatalog } from '@/hooks/usePropertyCatalog'
import { useAffectedSample } from '@/hooks/usePropertyInsights'
import {
  JobActiveError, PropertyJobRefusedError, createPropertyJob, getPropertyJob, previewPropertyJob,
  type PropertyJob, type PropertyJobPreview,
} from '@/services/versioningApiService'
import type { SearchCatalogProperty } from '@/types/search'
import { useDiscovery } from '../../search/builder/useDiscovery'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useBranchStore } from '@/store/branchStore'
import { usePropertyJobsStore, type OpRequest } from '@/store/propertyJobsStore'
import {
  EDGE_RESERVED_KEYS, applyLabel, impactOf, isCleanup, isEdgeTarget, jobOp, needsTypedConfirm, opProblem, predicateOf, propertyJobLabel,
  reviewCounts, scopeFixedToView, targetLabel, targetOf, tooManyIds, type OpDraft, type ScopeMode, type TargetPreset,
} from './opModel'
import { SECONDARY_EDGE } from './styles'
import { useReviewCounts } from './useReviewCounts'
import { entityTypesOf } from './fillRequired'
import { WhatStep } from './WhatStep'
import { WhereStep, type LayerOption } from './WhereStep'
import { ReviewStep } from './ReviewStep'

export interface GraphWrite { wsId: string; graphId: string; branchId: string }

const STEPS = ['What', 'Where', 'Review'] as const

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
  const [preset, setPreset] = useState<TargetPreset>(() => seed.target ?? (seed.key ? { kind: 'hasKey', key: seed.key } : { kind: 'view' }))
  const [scopeMode, setScopeMode] = useState<ScopeMode>(() => (seed.target?.kind === 'search' || seed.target?.kind === 'connections' ? seed.target.scopeMode : seed.scopeMode ?? 'view'))
  const [sourceConfirmed, setSourceConfirmed] = useState(false)
  // Relationships, not entities (`EdgeWhatStep`).
  const edges = isEdgeTarget(preset)
  // A change whose What is already whole (Remove from a row) opens on Where; a clean-up opens on
  // What, where its before → after is shown.
  const [step, setStep] = useState(() => (isCleanup(op.kind) || opProblem(op, !!seed.target && isEdgeTarget(seed.target)) ? 0 : 1))
  const [reason, setReason] = useState('')
  const cleanup = isCleanup(op.kind)
  // Opened with its property named (a fill from a refused publish, a catalog row): What focuses
  // what is still to give. And the target it was opened with, said on What when it has a name.
  const keySeeded = !!(seed.op?.key ?? seed.key)
  const seededFor = seed.target && 'label' in seed.target && seed.target.label ? targetLabel(preset) : null
  // A reusable change run as it was kept has nothing new to keep.
  const [openedAs] = useState(() => JSON.stringify([jobOp(op), preset, scopeMode]))
  const unchangedReusable = !!seed.reusable && JSON.stringify([jobOp(op), preset, scopeMode]) === openedAs

  // ── Where ──
  // A preset that named the old property follows a new one.
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
  const sample = useAffectedSample(viewId, reviewing && predicate && !edges && effectiveScope === 'view' ? predicate : null, reviewing && !!predicate && !edges)
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
        reason.trim() || `Bulk property: ${propertyJobLabel(jobOp(op))} on ${targetLabel(preset)}`)
      usePropertyJobsStore.getState().track({
        jobId: job.jobId, ...graphWrite, viewId, op: jobOp(op), targetLabel: targetLabel(preset),
        ...(edges ? { entityKind: 'edge' as const } : {}), startedAt: new Date().toISOString(), job,
      })
      notify('success', `Applying ${propertyJobLabel(jobOp(op))} to ${targetLabel(preset)} on your draft — follow it in Property Manager.`)
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
    if (step < 2) setStep(step + 1)
    else apply()
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || confirming) return
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); next() }
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      <Backdrop open onClick={onClose} zClassName="z-[80]" className="bg-black/50" />
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none" onKeyDown={onKeyDown}>
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="property-op-title"
          initial={{ opacity: 0, scale: 0.96, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={MOTION.modalSpring}
          className="pointer-events-auto relative flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl shadow-black/40"
        >
          <div className="flex items-start gap-3 border-b border-glass-border px-5 py-4 bg-gradient-to-br from-accent-lineage/[0.07] to-transparent">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-lineage/15 text-accent-lineage">
              <Database className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id="property-op-title" className="text-[15px] font-semibold leading-tight text-ink">{cleanup ? 'Clean up a property' : 'Change a property'}</h3>
              <p className="mt-0.5 text-[11.5px] text-ink-muted">
                {cleanup ? 'Tidy the values it holds' : 'On'} every {edges ? 'relationship' : 'entity'} it should reach — applied to your draft by the server.
              </p>
              {seed.reusable && (
                <p className="mt-1 break-words text-[11.5px] text-ink-secondary">From reusable change: <span className="font-semibold">{seed.reusable.name}</span></p>
              )}
              {step === 0 && seededFor && (
                <p className="mt-1 break-words text-[11.5px] text-ink-secondary">For: <span className="font-semibold">{seededFor}</span></p>
              )}
              <ol className="mt-3 flex items-center gap-1" aria-label="Steps">
                {STEPS.map((label, i) => {
                  const done = i < step
                  const reachable = i < step || (i === 1 && !whatProblem) || (i === 2 && !whatProblem && !whereProblem)
                  return (
                    <li key={label} className="flex items-center gap-1">
                      {i > 0 && <span className="h-px w-5 bg-black/[0.12] dark:bg-white/[0.12]" aria-hidden />}
                      <button type="button" disabled={!reachable} onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}
                        className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold transition-colors',
                          i === step ? 'bg-accent-lineage text-white' : done ? 'bg-accent-lineage/15 text-accent-lineage hover:bg-accent-lineage/25' : 'text-ink-muted disabled:opacity-60')}>
                        <span className={cn('inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px]', i === step ? 'bg-white/25' : 'bg-black/[0.06] dark:bg-white/10')}>
                          {done ? <Check className="h-2.5 w-2.5" aria-hidden /> : i + 1}
                        </span>
                        {label}
                      </button>
                    </li>
                  )
                })}
              </ol>
            </div>
            <IconButton icon={X} label="Close" shortcut="Esc" onClick={onClose} />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4">
            <PanelErrorBoundary resetKeys={[step]} onClose={onClose}>
              <motion.div key={step} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={MOTION.stepSwap}>
                {step === 0 && (edges
                  ? <EdgeWhatStep viewId={viewId} op={op} onChange={setOp} />
                  : <WhatStep op={op} onChange={setOp} properties={properties} viewId={viewId}
                    entityTypes={entityTypesOf(preset) ?? knownEntityTypes} keySeeded={keySeeded} />)}
                {step === 1 && (
                  <WhereStep
                    viewId={viewId} preset={preset} onPreset={setPreset} scopeMode={scopeMode} onScope={setScopeMode}
                    sourceConfirmed={sourceConfirmed} onConfirmSource={setSourceConfirmed} op={op}
                    selectionIds={selectionIds} layers={layers} seed={seed.target} knownEntityTypes={knownEntityTypes}
                  />
                )}
                {step === 2 && (
                  <ReviewStep
                    op={op} preset={preset} scopeMode={effectiveScope} counts={ids ? null : counts} impact={impact} exact={exact}
                    preview={preview.data} previewLoading={preview.loading} previewError={preview.error} onRetry={retry}
                    sample={sample.data} sampleLoading={sample.loading}
                    stagedCount={stagedCount} draftChanges={draftChanges} reason={reason} onReason={setReason} edges={edges}
                    onFollow={(jobId) => void follow(jobId)} onChangeTarget={() => setStep(1)} offerSave={!unchangedReusable}
                  />
                )}
              </motion.div>
            </PanelErrorBoundary>
          </div>

          <div className="flex items-center gap-2 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-5 py-3">
            <span role={error ? 'alert' : undefined} className={cn('min-w-0 flex-1 truncate text-[11.5px]', error ? 'text-rose-600 dark:text-rose-400' : 'text-ink-muted')}>
              {error?.message ?? (step === 0 ? whatProblem : step === 1 ? whereProblem : blockedReason) ?? ''}
            </span>
            {error instanceof PropertyJobRefusedError && error.code === 'too_many_ids' && (
              <Button size="sm" variant="ghost" onClick={() => { setError(null); setStep(1) }}>Choose another target</Button>
            )}
            {step > 0 && <Button size="sm" variant="ghost" leftIcon={ArrowLeft} onClick={() => setStep(step - 1)}>Back</Button>}
            <Button size="sm" variant={jobActive ? 'secondary' : step === 2 && (op.kind === 'remove') ? 'danger' : 'primary'}
              className={cn(jobActive && SECONDARY_EDGE)} rightIcon={step < 2 ? ArrowRight : undefined}
              disabled={!canNext} loading={submitting} onClick={next}>
              {step < 2 ? 'Next' : error ? 'Try again' : applyLabel(impact, final, exact)}
            </Button>
            {jobActive && <Button size="sm" variant="primary" onClick={() => void follow(jobActive.jobId)}>Follow it</Button>}
          </div>
        </motion.div>
      </div>
      {confirming && (
        <DangerConfirmDialog
          isOpen
          title={`${propertyJobLabel(jobOp(op))} on ${impact ? `${exact ? '' : 'about '}${impact.changes.toLocaleString()}` : 'an unknown number of'} ${edges ? 'relationships' : 'entities'}?`}
          subtitle={`On ${targetLabel(preset)}${effectiveScope === 'data_source' ? ', across the whole data source' : ''} — in your draft, until it is published.`}
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

/** The What step for relationships: a property named from the keys the view's relationships carry. */
function EdgeWhatStep({ viewId, op, onChange }: { viewId: string; op: OpDraft; onChange: (op: OpDraft) => void }) {
  const { keysByEdgeType } = useDiscovery(viewId)
  const properties = useMemo(() => edgePropertiesOf(keysByEdgeType), [keysByEdgeType])
  return <WhatStep op={op} onChange={onChange} properties={properties} viewId={viewId} edges />
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
