/**
 * Importing every view in a file at once — a workspace promoted from one environment to the next.
 *
 * The per-view wizard steps don't scale to thirty views, so this is its own short flow; deep
 * edits happen afterwards in each view's own wizard, or by importing one view on its own:
 *
 *   Targets  one row per SOURCE in the file, mapped to a data source here (suggested, and
 *            measured on a sample of that source's entities). Views already here update in place.
 *   Match    every view checked in one request (one identity lookup per data source); an
 *            aggregate score, and per view its score, verdict and what to do with it (update,
 *            copy, create, overwrite another view, skip), with the full account a click away.
 *            A type missing where views land is mapped once for all the views from that source.
 *   Review   per view: its name (duplicates flagged) and who sees it; and, where a data source is
 *            under version control, whether the views go live now or wait in drafts for review.
 *   Import   one request per view, each with its own request id (a retry is safe) and the batch
 *            id that ties them together; live progress; a failure never stops the rest. Views
 *            that wait in drafts (one draft per view) can then all be submitted for review.
 */
import { useCallback, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronRight, GitPullRequest, Loader2, RefreshCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { useWorkspacesStore } from '@/store/workspaces'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { getView, listViews, type View } from '@/services/viewApiService'
import {
  ViewTransferError, importView, newRequestId, reconcileViews,
  type ImportAction, type InspectedView, type InspectResult, type ReconciledView, type ReconcileReport,
  type ReconcileTypeRow, type ReconcileVerdict, type Resolutions, type TransferTarget, type UpdateStrategy,
} from '@/services/viewTransferApiService'
import { recordEvent } from '@/services/telemetryService'
import { PullRequestExistsError, openMergeRequest } from '@/services/versioningApiService'
import { VERSIONING_KEYS } from '@/features/versioning/hooks/useVersioning'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import { MatchScoreRing } from '@/features/view-transfer/reconcile/MatchScoreRing'
import { ReconciliationPanel } from '@/features/view-transfer/reconcile/ReconciliationPanel'
import { sameResolutions, withDecisions } from '@/features/view-transfer/reconcile/resolutions'
import { TONE_CHIP, matchBucket, percent, pluralize } from '@/features/view-transfer/format'
import { TypeMappingTable } from '@/features/view-transfer/reconcile/TypeMappingTable'
import { withTypeDecision } from '@/features/view-transfer/reconcile/resolutions'
import { useImportSession } from './importSession'
import { OverwritePicker } from './ImportStep'
import { StageChoice } from './StageChoice'
import { useDraftStagingFor, type DraftStaging } from './useDraftStaging'

/** The wizard's own step ids: target(s), reconcile (Match), preview (Review). */
type Step = 'target' | 'reconcile' | 'preview'
type Visibility = 'private' | 'workspace'
type RunState = 'pending' | 'running' | 'done' | 'failed'
type SourceTarget = { workspaceId: string; dataSourceId: string } | null
/** A view here, with its scope. */
type ViewHere = { viewId: string; name: string; workspaceId: string; dataSourceId: string | null }

interface Entry {
  view: InspectedView
  action: ImportAction
  skipped: boolean
  /** The view here it already is (an update). */
  here: ViewHere | null
  /** The view here it replaces, when it overwrites one. */
  overwrite: ViewHere | null
  strategy: UpdateStrategy
  name: string
  visibility: Visibility
  /** The choices the last check reflects, and the ones being made. */
  resolutions: Resolutions
  draft: Resolutions
  reconciled: ReconciledView | null
  /** Bumped by every change that makes `reconciled` stale (another target, action or strategy),
   *  so a check already in flight for the old inputs can't land on the new ones. */
  epoch: number
  requestId: string
  run: {
    state: RunState; viewId?: string; version?: number | null; matchRate?: number | null; verified?: boolean
    /** The draft it waits in, when it was imported into one. */
    branchId?: string | null
    error?: string
  }
  /** Its draft's review request, once it's submitted for review. */
  review?: { state: 'sending' | 'sent' | 'failed'; prId?: string; workspaceId?: string; error?: string }
}

/** How many exceptions a report lists at most (the server's `MAX_EXCEPTIONS`). */
const MAX_LISTED = 20_000
const VERDICT_LABEL: Record<ReconcileVerdict, string> = { ready: 'Ready', attention: 'Worth a look', blocked: 'Can’t import' }
const VERDICT_TONE: Record<ReconcileVerdict, string> = { ready: TONE_CHIP.emerald, attention: TONE_CHIP.amber, blocked: TONE_CHIP.rose }

function initialEntries(inspect: InspectResult): Entry[] {
  return inspect.views.map(view => {
    const match = (inspect.identityMatches[view.portableId] ?? []).find(m => m.canEdit)
    return {
      view,
      action: match ? 'update' : 'create',
      skipped: false,
      here: match ? { viewId: match.viewId, name: match.name, workspaceId: match.workspaceId, dataSourceId: match.dataSourceId ?? null } : null,
      overwrite: null,
      strategy: 'replace',
      name: match ? match.name : view.metadata.name,
      visibility: 'private',
      resolutions: {},
      draft: {},
      reconciled: null,
      epoch: 0,
      requestId: newRequestId(),
      run: { state: 'pending' },
    }
  })
}

/** Each source starts at its best suggestion, when a sample found at least half its entities there. */
function initialTargets(inspect: InspectResult): Record<string, SourceTarget> {
  const out: Record<string, SourceTarget> = {}
  for (const key of Object.keys(inspect.bundle.sources)) {
    const best = inspect.targetSuggestions[key]?.[0]
    out[key] = best && (best.sampleHitRate ?? 0) >= 0.5 ? { workspaceId: best.workspaceId, dataSourceId: best.dataSourceId } : null
  }
  return out
}

/** The view here an entry writes to: the one it is (an update), or the one it overwrites. */
function viewHere(e: Entry): ViewHere | null {
  return e.action === 'update' ? e.here : e.action === 'overwrite' ? e.overwrite : null
}

/** The data source an entry lands in: the one of the view it writes to, or its source's target. */
function scopeFor(e: Entry, targets: Record<string, SourceTarget>): { workspaceId: string; dataSourceId: string | null } | null {
  const v = viewHere(e)
  if (v) return { workspaceId: v.workspaceId, dataSourceId: v.dataSourceId }
  const t = targets[e.view.source]
  return t ? { workspaceId: t.workspaceId, dataSourceId: t.dataSourceId } : null
}

/** Where an entry goes: the view it writes to, or its source's data source here. */
function targetFor(e: Entry, targets: Record<string, SourceTarget>): TransferTarget | null {
  const v = viewHere(e)
  if (v) return { viewId: v.viewId }
  const t = targets[e.view.source]
  return t ? { ...t } : null
}

export function BatchImport({ steps, onBackToFile, onClose }: {
  steps: WizardStepDef[]
  onBackToFile: () => void
  onClose: () => void
}) {
  const session = useImportSession()!
  const inspect = session.inspect!
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workspaces = useWorkspacesStore(s => s.workspaces)
  const [step, setStep] = useState<Step>('target')
  const [phase, setPhase] = useState<'steps' | 'importing' | 'done'>('steps')
  const [targets, setTargets] = useState<Record<string, SourceTarget>>(() => initialTargets(inspect))
  const [entries, setEntries] = useState<Entry[]>(() => initialEntries(inspect))
  const [checksInFlight, setChecksInFlight] = useState(0)
  const [reconcileError, setReconcileError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  /** The view whose overwrite target is being picked. */
  const [picking, setPicking] = useState<number | null>(null)
  const [stageChoice, setStageChoice] = useState<boolean | null>(null)
  const [batchId] = useState(newRequestId)
  const environment = inspect.bundle.generator.environment
  const reconciling = checksInFlight > 0

  const active = useMemo(() => entries.filter(e => !e.skipped), [entries])
  /** Sources a NEW view needs a target for (updates follow the view they update). */
  const neededSources = useMemo(
    () => new Set(active.filter(e => !viewHere(e)).map(e => e.view.source)),
    [active],
  )
  const dataSources = useMemo(() => workspaces.flatMap(ws => (ws.dataSources ?? []).map(ds => ({
    workspaceId: ws.id, workspaceName: ws.name, dataSourceId: ds.id, label: ds.label || ds.catalogItemId || 'Data source',
  }))), [workspaces])
  const labelOf = (t: SourceTarget) => {
    if (!t) return 'Not chosen'
    const ds = dataSources.find(d => d.dataSourceId === t.dataSourceId)
    return ds ? `${ds.workspaceName} · ${ds.label}` : t.dataSourceId
  }

  const setEntry = useCallback((index: number, patch: Partial<Entry>) => {
    setEntries(prev => prev.map(e => (e.view.index === index ? { ...e, ...patch } : e)))
  }, [])

  // ── Match ──
  /** Check the views in `list` that need it: never checked, or with choices not yet applied. */
  const check = useCallback(async (list: Entry[]) => {
    const runnable = list.flatMap(e => {
      const target = targetFor(e, targets)
      return !e.skipped && target && (!e.reconciled || !sameResolutions(e.resolutions, e.draft)) ? [{ e, target }] : []
    })
    if (runnable.length === 0) return
    const sent = new Map(runnable.map(({ e }) => [String(e.view.index), { epoch: e.epoch, choices: e.draft }]))
    setChecksInFlight(n => n + 1)
    setReconcileError(null)
    try {
      const result = await reconcileViews(runnable.map(({ e, target }) => ({
        key: String(e.view.index),
        portableId: e.view.portableId,
        definition: e.view.definition,
        viewType: e.view.metadata.viewType,
        manifest: e.view.manifest,
        history: e.view.history.map(h => h.hash),
        target,
        action: e.action,
        strategy: e.strategy,
        resolutions: e.draft,
      })))
      const byKey = new Map(result.views.map(v => [v.key, v]))
      setEntries(prev => prev.map(e => {
        const key = String(e.view.index)
        const r = byKey.get(key)
        const asked = sent.get(key)
        return r && asked && asked.epoch === e.epoch ? { ...e, reconciled: r, resolutions: asked.choices } : e
      }))
    } catch (err) {
      setReconcileError(err instanceof Error ? err.message : 'The views could not be checked.')
    } finally {
      setChecksInFlight(n => n - 1)
    }
  }, [targets])

  /** A change that makes an entry's check stale; on the Match step it's checked again at once. */
  const rework = (e: Entry, patch: Partial<Entry>) => {
    const next = { ...e, ...patch, reconciled: null, epoch: e.epoch + 1 }
    setEntries(prev => prev.map(x => (x.view.index === e.view.index ? next : x)))
    if (step === 'reconcile') void check([next])
  }

  const chooseAction = (e: Entry, choice: ImportAction | 'skip') => {
    if (choice === 'skip') {
      setEntry(e.view.index, { skipped: true })
      return
    }
    if (choice === 'overwrite' && (e.action !== 'overwrite' || e.skipped || !e.overwrite)) {
      setPicking(e.view.index)          // which view it replaces is picked first (overwriteWith)
      return
    }
    if (choice === e.action) {
      setEntry(e.view.index, { skipped: false })
      if (step === 'reconcile' && !e.reconciled) void check([{ ...e, skipped: false }])
      return
    }
    setExpanded(null)
    rework(e, {
      action: choice, skipped: false,
      name: choice === 'update' && e.here ? e.here.name : e.view.metadata.name,
    })
  }

  const overwriteWith = (e: Entry, v: ViewHere) => {
    setPicking(null)
    setExpanded(null)
    rework(e, { action: 'overwrite', overwrite: v, skipped: false, name: v.name })
  }
  /** Views here that another entry already writes to: one view can't take two designs. */
  const takenBy = (e: Entry) => active.flatMap(x => {
    const v = x.view.index === e.view.index ? null : viewHere(x)
    return v ? [v.viewId] : []
  })

  // ── Types: a type missing where views land is mapped once, for every view from that source ──
  const typeGroups = useMemo(() => {
    type Group = {
      key: string; source: string; scope: { workspaceId: string; dataSourceId: string | null }; entries: Entry[]
      entity: Map<string, ReconcileTypeRow>; relationship: Map<string, ReconcileTypeRow>
      available: ReconcileReport['availableTypes']
    }
    const groups = new Map<string, Group>()
    for (const e of active) {
      const report = e.reconciled?.report
      const scope = scopeFor(e, targets)
      if (!report || !scope) continue
      const key = `${e.view.source}|${scope.workspaceId}|${scope.dataSourceId}`
      const g: Group = groups.get(key) ?? { key, source: e.view.source, scope, entries: [], entity: new Map(), relationship: new Map(), available: report.availableTypes }
      groups.set(key, g)
      g.entries.push(e)
      for (const kind of ['entity', 'relationship'] as const) {
        for (const row of report.types[kind]) {
          if (row.status !== 'missing') continue
          const seen = g[kind].get(row.id)
          g[kind].set(row.id, seen ? { ...seen, layers: [...new Set([...seen.layers, ...row.layers])] } : row)
        }
      }
    }
    return [...groups.values()]
  }, [active, targets])
  const decideTypeFor = (group: { entries: Entry[] }) => (kind: 'entity' | 'relationship', id: string, target: string | null | undefined) => {
    const members = new Set(group.entries.map(e => e.view.index))
    setEntries(prev => prev.map(e => (members.has(e.view.index) ? { ...e, draft: withTypeDecision(e.draft, kind, id, target) } : e)))
  }

  const dirty = active.some(e => !sameResolutions(e.resolutions, e.draft))
  /** Views with entities whose lookup failed: neither found nor missing, and worth another try. */
  const unchecked = active.some(e => (e.reconciled?.report.summary.entities.unknown ?? 0) > 0)
  const recheck = () => void check(entries.map(e => (
    (e.reconciled?.report.summary.entities.unknown ?? 0) > 0 ? { ...e, reconciled: null } : e)))
  const checked = active.every(e => e.reconciled)
  const blocked = active.filter(e => e.reconciled?.report.summary.verdict === 'blocked')
  const aggregate = useMemo(() => {
    let found = 0
    let seen = 0
    for (const e of active) {
      const s = e.reconciled?.report.summary.entities
      if (s) { found += s.found; seen += s.checked }
    }
    return seen ? found / seen : null
  }, [active])
  const verdict: ReconcileVerdict = blocked.length ? 'blocked'
    : checked && active.every(e => e.reconciled?.report.summary.verdict === 'ready') ? 'ready' : 'attention'

  const dropAllMissing = () => {
    setEntries(prev => prev.map(e => {
      const missing = (e.reconciled?.report.entities ?? []).filter(x => x.status === 'missing').map(x => x.urn)
      return !e.skipped && missing.length ? { ...e, draft: withDecisions(e.draft, missing, { kind: 'drop' }) } : e
    }))
  }

  const importOnItsOwn = (e: Entry) => {
    session.setBatch(false)
    session.setViewIndex(e.view.index)
    onBackToFile()
  }

  // ── Review: the current details of views being updated (an update keeps them) ──
  const updating = active.filter(e => viewHere(e))
  const currentViews = useQueries({
    queries: updating.map(e => ({
      queryKey: [...VIEW_QUERY_KEY, viewHere(e)!.viewId],
      queryFn: () => getView(viewHere(e)!.viewId),
      enabled: step !== 'target',
      staleTime: 60_000,
    })),
  })
  const current: Record<string, View | undefined> = Object.fromEntries(updating.map((e, i) => [viewHere(e)!.viewId, currentViews[i]?.data]))
  const currentLoaded = updating.every(e => current[viewHere(e)!.viewId])
  /** Views being updated that couldn't be read here (deleted, or access lost since the check). */
  const unreadable = updating.filter((_, i) => currentViews[i]?.isError)

  /** How many new views go to each workspace under each (lower-cased) name. */
  const namesInBatch = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of active) {
      if (viewHere(e)) continue
      const key = `${targets[e.view.source]?.workspaceId}|${e.name.trim().toLowerCase()}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [active, targets])

  // ── Drafts: where a data source is under version control, views can wait in drafts for review ──
  const staging = useDraftStagingFor(active.map(e => scopeFor(e, targets)).filter((t): t is NonNullable<typeof t> => !!t))
  const stagingOf = (e: Entry): DraftStaging | undefined => {
    const ds = scopeFor(e, targets)?.dataSourceId
    return ds ? staging[ds] : undefined
  }
  const stageable = active.filter(e => stagingOf(e)?.versioned)
  const stagesAll = stageChoice ?? true
  const staged = (e: Entry) => stagesAll && !!stagingOf(e)?.versioned && !!stagingOf(e)?.allowed
  const batchStaging: DraftStaging = {
    versioned: stageable.length > 0,
    allowed: stageable.every(e => stagingOf(e)?.allowed),
    checking: active.some(e => stagingOf(e)?.checking),
  }
  const stageKind = stageable.every(e => viewHere(e)) ? 'update'
    : stageable.every(e => !viewHere(e)) ? 'new' : 'mixed'

  // ── Import ──
  const importAll = async () => {
    setPhase('importing')
    const queue = active.filter(e => e.run.state !== 'done')
    for (const e of queue) {
      setEntry(e.view.index, { run: { state: 'running' } })
      const r = e.reconciled!
      const writesTo = viewHere(e)
      const here = writesTo ? current[writesTo.viewId] : undefined
      try {
        const result = await importView({
          action: e.action,
          strategy: e.strategy,
          target: targetFor(e, targets)!,
          metadata: writesTo
            ? {
              name: e.name.trim(),
              description: here?.description ?? null,
              icon: (here?.config?.icon as string | undefined) ?? null,
              tags: here?.tags ?? [],
              viewType: e.view.metadata.viewType,
            }
            : { ...e.view.metadata, name: e.name.trim(), visibility: e.visibility },
          definition: r.effectiveDefinition,
          originDefinition: r.effectiveHash !== e.view.actualHash ? e.view.definition : undefined,
          origin: {
            portableId: e.view.portableId, sourceViewId: e.view.sourceViewId, version: e.view.version,
            definitionHash: e.view.definitionHash, name: e.view.metadata.name, environment,
            exportedAt: inspect.bundle.exportedAt, exportedBy: inspect.bundle.exportedBy.displayName,
            fileName: session.fileName,
          },
          manifest: e.view.manifest,
          history: e.view.history,
          resolutions: e.resolutions,
          expectedTargetHash: r.update?.targetWorkingHash ?? null,
          requestId: e.requestId,
          batchId,
          ...(staged(e) ? { stage: true } : {}),
        })
        setEntry(e.view.index, { run: {
          state: 'done', viewId: result.viewId, version: result.version?.version ?? null,
          matchRate: result.report.summary.matchRate, verified: result.integrity.verified,
          branchId: result.staged?.branchId ?? null,
        } })
        recordEvent('view.import', {
          action: e.action, strategy: e.strategy, staged: !!result.staged,
          match: matchBucket(result.report.summary.matchRate), batch: true,
        })
      } catch (err) {
        // The view here changed after it was checked: its check is stale, and a retry with the old
        // one would only be refused again. It is checked again before the next attempt.
        const changed = err instanceof ViewTransferError && err.type === 'target_changed'
        setEntry(e.view.index, {
          run: { state: 'failed', error: err instanceof Error ? err.message : 'Import failed' },
          ...(changed ? { reconciled: null, epoch: e.epoch + 1 } : {}),
        })
      }
    }
    void queryClient.invalidateQueries({ queryKey: ['views'] })
    void queryClient.invalidateQueries({ queryKey: ['explorer-views'] })
    setPhase('done')
  }

  const goTo = (next: Step) => {
    setStep(next)
    if (next === 'reconcile') void check(entries)
  }

  const canProceed = step === 'target'
    ? active.length > 0 && [...neededSources].every(k => targets[k])
    : step === 'reconcile'
      ? active.length > 0 && checked && !dirty && !reconciling && blocked.length === 0
      : active.every(e => e.name.trim().length > 0) && currentLoaded
  const done = active.filter(e => e.run.state === 'done')
  const failed = active.filter(e => e.run.state === 'failed')
  const toImport = active.length - done.length
  const checkAgain = failed.some(e => !e.reconciled)

  // ── Review: each view that waits in a draft goes to review on its own (a draft per view) ──
  const reviewing = active.some(e => e.review?.state === 'sending')
  const reviewable = done.filter(e => e.run.branchId && stagingOf(e)?.graphId && stagingOf(e)?.allowed
    && e.review?.state !== 'sent' && e.review?.state !== 'sending')
  const submitForReview = async () => {
    for (const e of reviewable) {
      const workspaceId = scopeFor(e, targets)!.workspaceId
      const graphId = stagingOf(e)!.graphId!
      setEntry(e.view.index, { review: { state: 'sending' } })
      try {
        const { prId } = await openMergeRequest(workspaceId, graphId, e.run.branchId!, {
          title: `Import “${e.name.trim()}”`,
          description: `Imported from ${environment || 'another environment'}${e.view.version ? ` v${e.view.version}` : ''}, `
            + `${percent(e.run.matchRate)} matched.`,
        })
        setEntry(e.view.index, { review: { state: 'sent', prId, workspaceId } })
      } catch (err) {
        // Already in review (a second click, another tab): that review is the one.
        setEntry(e.view.index, { review: err instanceof PullRequestExistsError
          ? { state: 'sent', prId: err.prId, workspaceId }
          : { state: 'failed', error: err instanceof Error ? err.message : 'Couldn’t submit it for review' } })
      }
      void queryClient.invalidateQueries({ queryKey: VERSIONING_KEYS.mergeRequests(workspaceId, graphId) })
    }
    for (const list of ['viewPrs', 'dataSourcePrs', 'viewPrCounts']) {
      void queryClient.invalidateQueries({ queryKey: [...VERSIONING_KEYS.all, list] })
    }
  }

  const footer = phase === 'importing' ? (
    <div className="flex items-center gap-2 text-sm text-ink-muted">
      <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
      Importing {Math.min(done.length + failed.length + 1, active.length)} of {active.length}…
    </div>
  ) : phase === 'done' ? (
    <div className="flex items-center justify-end gap-2 w-full">
      {(reviewable.length > 0 || reviewing) && (
        <button type="button" onClick={() => void submitForReview()} disabled={reviewing}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 disabled:opacity-60">
          {reviewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitPullRequest className="w-4 h-4" />}
          {reviewing ? 'Submitting for review…' : `Submit ${pluralize(reviewable.length, 'draft')} for review`}
        </button>
      )}
      {failed.length > 0 && (
        <button type="button"
          onClick={() => {
            if (!checkAgain) return void importAll()
            setPhase('steps')
            goTo('reconcile')
          }}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5">
          <RefreshCw className="w-4 h-4" />
          {checkAgain ? 'Check the changed views again' : `Retry ${pluralize(failed.length, 'failed import')}`}
        </button>
      )}
      <button type="button" onClick={onClose}
        className="px-6 py-2.5 rounded-xl font-medium bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md">
        Done
      </button>
    </div>
  ) : undefined

  return (
    <WizardShell
      title="Import Views"
      submitLabel={`Import ${pluralize(toImport, 'view')}`}
      currentStep={step}
      activeSteps={steps}
      currentStepIndex={steps.findIndex(s => s.id === step)}
      onStepClick={(id) => { if (id === 'file') onBackToFile(); else if (id !== step) goTo(id as Step) }}
      onBack={() => (step === 'target' ? onBackToFile() : setStep(step === 'preview' ? 'reconcile' : 'target'))}
      onNext={() => goTo(step === 'target' ? 'reconcile' : 'preview')}
      onClose={onClose}
      canProceed={canProceed}
      isLastStep={step === 'preview'}
      isSubmitting={false}
      onSubmit={() => void importAll()}
      terminalPhase={phase === 'importing' ? 'creating' : phase === 'done' ? 'success' : undefined}
      terminalLabel={phase === 'done' ? 'Imported' : 'Import'}
      terminalSubtitle={phase === 'done'
        ? `${pluralize(done.length, 'view')} imported${failed.length ? `, ${failed.length} failed` : ''}`
        : 'Importing your views…'}
      hideClose={phase === 'importing'}
      footer={footer}
      wide
    >
      {phase !== 'steps' ? (
        <ProgressList entries={active} onOpen={(viewId, branchId) => {
          navigate(branchId ? `/views/${viewId}?branch=${branchId}` : `/views/${viewId}`)
          onClose()
        }} onOpenReview={(workspaceId, prId) => {
          navigate(`/workspaces/${workspaceId}/reviews?pr=${prId}`)
          onClose()
        }} />
      ) : step === 'target' ? (
        <div className="space-y-5">
          <div>
            <h3 className="text-xl font-bold text-ink">Where should these views go?</h3>
            <p className="text-sm text-ink-muted mt-0.5">
              For each data source the views were built on, choose the one here that holds the same graph.
              Views that are already here are updated where they are.
            </p>
          </div>
          <div className="rounded-2xl border border-glass-border divide-y divide-glass-border">
            {Object.entries(inspect.bundle.sources).map(([key, source]) => {
              const views = entries.filter(e => e.view.source === key)
              const updatingHere = views.filter(e => viewHere(e) && !e.skipped).length
              const suggestions = inspect.targetSuggestions[key] ?? []
              const t = targets[key]
              const name = source.dataSource.label || source.dataSource.graphName || 'A data source'
              return (
                <div key={key} className="flex items-center gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-ink truncate">
                      {name}
                      {source.workspace.name ? <span className="font-normal text-ink-muted"> in {source.workspace.name}</span> : null}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      {pluralize(views.length, 'view')}{updatingHere ? `, ${updatingHere} already here` : ''}
                      {source.dataSource.providerType ? ` · ${source.dataSource.providerType}` : ''}
                      {source.dataSource.graphName ? ` · ${source.dataSource.graphName}` : ''}
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-ink-muted shrink-0" />
                  {neededSources.has(key) ? (
                    <select value={t ? `${t.workspaceId}|${t.dataSourceId}` : ''} aria-label={`Where views from ${name} go`}
                      onChange={(ev) => {
                        const [workspaceId, dataSourceId] = ev.target.value.split('|')
                        setTargets(prev => ({ ...prev, [key]: ev.target.value ? { workspaceId, dataSourceId } : null }))
                        setEntries(prev => prev.map(x => (x.view.source === key && x.action !== 'update'
                          ? { ...x, reconciled: null, epoch: x.epoch + 1 } : x)))
                      }}
                      className="w-80 text-xs rounded-lg border border-glass-border bg-canvas-elevated px-2 py-1.5 text-ink">
                      <option value="">Choose a data source…</option>
                      {suggestions.length > 0 && (
                        <optgroup label="Suggested (share of a sample found there)">
                          {suggestions.map(s => (
                            <option key={s.dataSourceId} value={`${s.workspaceId}|${s.dataSourceId}`}>
                              {s.workspaceName} · {s.label}{s.sampleHitRate !== null ? ` — ${percent(s.sampleHitRate, 0)} found` : ''}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="All data sources">
                        {dataSources.map(d => (
                          <option key={d.dataSourceId} value={`${d.workspaceId}|${d.dataSourceId}`}>{d.workspaceName} · {d.label}</option>
                        ))}
                      </optgroup>
                    </select>
                  ) : (
                    <span className="w-80 text-[11px] text-ink-muted">{updatingHere ? 'Updated where they are' : 'Nothing to import'}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : step === 'reconcile' ? (
        <div className="space-y-5">
          <div className="flex items-center gap-6 rounded-2xl border border-glass-border p-5">
            <MatchScoreRing rate={aggregate} verdict={verdict} />
            <div className="min-w-0 flex-1 space-y-2">
              <h3 className="text-xl font-bold text-ink">How they fit here</h3>
              <p className="text-sm text-ink-muted">
                {reconciling ? 'Checking every entity each view places…'
                  : `${pluralize(active.length, 'view')} to import. Open one for its full account, and decide what happens to what wasn’t found.`}
              </p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={dropAllMissing} disabled={reconciling || !checked}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-rose-600 hover:bg-rose-500/10 disabled:opacity-40">
                  Drop everything not found
                </button>
                {(dirty || reconcileError || unchecked) && (
                  <button type="button" onClick={recheck} disabled={reconciling}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-60">
                    {reconciling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    {reconcileError ? 'Try again' : dirty ? 'Re-check with these choices' : 'Check again'}
                  </button>
                )}
              </div>
              {unchecked && !dirty && !reconciling && (
                <p className="text-[11px] text-ink-muted">
                  Some entities couldn’t be checked because the lookup failed. Check again to look them up.
                </p>
              )}
              {active.some(e => e.reconciled?.report.entitiesTruncated) && (
                <p className="text-[11px] text-ink-muted">
                  A view lists only its first {MAX_LISTED.toLocaleString()} entities not found, so this drops those. Re-check, then drop the rest.
                </p>
              )}
              {reconcileError && <p className="text-xs text-rose-500">{reconcileError}</p>}
            </div>
          </div>
          {typeGroups.map(g => {
            const entityRows = [...g.entity.values()]
            const relationshipRows = [...g.relationship.values()]
            const lead = g.entries[0]
            if (!entityRows.length && !relationshipRows.length
              && !Object.keys(lead.draft.typeMap ?? {}).length && !lead.draft.dropTypes?.length
              && !Object.keys(lead.draft.relTypeMap ?? {}).length && !lead.draft.dropRelTypes?.length) return null
            const source = inspect.bundle.sources[g.source]
            return (
              <section key={g.key} className="space-y-2">
                <div>
                  <h4 className="text-sm font-bold text-ink">Types that don’t exist here</h4>
                  <p className="text-[11px] text-ink-muted mt-0.5">
                    Used by the views from {source?.dataSource.label || source?.dataSource.graphName || 'this source'} going
                    to {g.scope.dataSourceId ? labelOf({ workspaceId: g.scope.workspaceId, dataSourceId: g.scope.dataSourceId }) : 'this workspace'}
                    {' '}({pluralize(g.entries.length, 'view')}). A choice here applies to all of them; a view’s own account can change it for that view.
                  </p>
                </div>
                <TypeMappingTable entityTypes={entityRows} relationshipTypes={relationshipRows}
                  available={g.available ?? { entity: [], relationship: [] }} draft={lead.draft} onDecide={decideTypeFor(g)} />
              </section>
            )
          })}
          {blocked.length > 0 && (
            <p className="flex items-center gap-2 rounded-xl bg-rose-500/[0.07] border border-rose-500/20 px-3 py-2 text-[11px] text-rose-800 dark:text-rose-200">
              <AlertTriangle className="w-3.5 h-3.5" /> {pluralize(blocked.length, 'view')} can’t be imported where they’re going. Skip them, or choose another target.
            </p>
          )}
          <div className="rounded-2xl border border-glass-border divide-y divide-glass-border">
            {entries.map(e => {
              const r = e.reconciled
              const s = r?.report.summary
              const open = expanded === e.view.index && !!r && !e.skipped
              const target = targetFor(e, targets)
              return (
                <div key={e.view.index}>
                  <div className={cn('flex items-center gap-3 px-4 py-2.5', e.skipped && 'opacity-60')}>
                    <button type="button" onClick={() => setExpanded(open ? null : e.view.index)} disabled={!r || e.skipped}
                      aria-label={open ? `Hide the account of ${e.view.metadata.name}` : `Show the account of ${e.view.metadata.name}`}
                      className="text-ink-muted disabled:opacity-30">
                      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-ink truncate">{e.view.metadata.name}</p>
                      <p className="text-[11px] text-ink-muted truncate">
                        {e.action === 'overwrite' && e.overwrite ? (
                          <>
                            Overwrites “{e.overwrite.name}”{' '}
                            <button type="button" onClick={() => setPicking(e.view.index)}
                              className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">Change</button>
                          </>
                        ) : e.action === 'update' && e.here ? `Updates “${e.here.name}”` : `New in ${labelOf(targets[e.view.source])}`}
                      </p>
                    </div>
                    <select value={e.skipped ? 'skip' : e.action} aria-label={`What to do with ${e.view.metadata.name}`}
                      onChange={(ev) => chooseAction(e, ev.target.value as ImportAction | 'skip')}
                      className="text-[11px] rounded-lg border border-glass-border bg-canvas-elevated px-2 py-1 text-ink w-32">
                      {e.here ? (
                        <>
                          <option value="update">Update it</option>
                          <option value="copy">Separate copy</option>
                        </>
                      ) : <option value="create">Create</option>}
                      <option value="overwrite">{e.action === 'overwrite' ? 'Overwrite' : 'Overwrite another…'}</option>
                      <option value="skip">Skip</option>
                    </select>
                    <span className="w-40 flex items-center justify-end gap-2">
                      {e.skipped ? <span className="text-[11px] text-ink-muted">Skipped</span>
                        : !target ? (
                          <button type="button" onClick={() => setStep('target')}
                            className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 hover:underline">Choose a target</button>
                        ) : !r ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" aria-label="Checking" />
                          : (
                            <>
                              <span className="text-xs font-bold tabular-nums">{percent(s!.matchRate, 0)}</span>
                              <span className={cn('text-[10px] font-semibold px-2 py-0.5 rounded-full', VERDICT_TONE[s!.verdict])}>
                                {VERDICT_LABEL[s!.verdict]}
                              </span>
                            </>
                          )}
                    </span>
                  </div>
                  {picking === e.view.index && (
                    <div className="px-4 pb-3 space-y-1.5">
                      <p className="text-[11px] text-ink-muted">
                        Which view here does “{e.view.metadata.name}” replace? Its design is saved as a version first, and
                        it keeps its sharing.
                      </p>
                      <OverwritePicker exclude={[...takenBy(e), ...(e.here ? [e.here.viewId] : [])]}
                        onPick={(v) => overwriteWith(e, {
                          viewId: v.viewId, name: v.name, workspaceId: v.workspaceId, dataSourceId: v.dataSourceId ?? null,
                        })} />
                      <button type="button" onClick={() => setPicking(null)}
                        className="text-[11px] font-medium text-ink-muted hover:text-ink">Cancel</button>
                    </div>
                  )}
                  {open && (
                    <div className="px-4 pb-4 space-y-2">
                      <ReconciliationPanel reconciled={r!} applied={e.resolutions} draft={e.draft}
                        onDraft={(d) => setEntry(e.view.index, { draft: d })}
                        onStrategy={viewHere(e) ? (strategy) => rework(e, { strategy }) : undefined}
                        sourceLabel={`${environment ?? 'The file'} · ${e.view.metadata.name}`}
                        targetLabel={viewHere(e) ? `“${viewHere(e)!.name}”` : labelOf(targets[e.view.source])}
                        targetName={viewHere(e)?.name}
                        exportedNames={e.view.manifest.entities}
                        searchScope={scopeFor(e, targets)} />
                      <button type="button" onClick={() => importOnItsOwn(e)}
                        className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                        Import this view on its own, with every step of the wizard…
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <div>
            <h3 className="text-xl font-bold text-ink">Review</h3>
            <p className="text-sm text-ink-muted mt-0.5">
              Views being updated keep their description, icon and tags; new views take the file’s, under the name
              you give them. To share a view with everyone, use its Share once it’s here.
            </p>
          </div>
          {batchStaging.versioned && (
            <div className="space-y-2">
              <StageChoice staging={batchStaging} stage={stagesAll && batchStaging.allowed} onChange={setStageChoice}
                kind={stageKind} count={stageable.length} />
              {stageable.length < active.length && (
                <p className="text-[11px] text-ink-muted px-1">
                  {pluralize(active.length - stageable.length, 'view')} {active.length - stageable.length === 1 ? 'goes' : 'go'} live
                  now either way: {active.length - stageable.length === 1 ? 'its data source isn’t' : 'their data sources aren’t'} under version control.
                </p>
              )}
            </div>
          )}
          {unreadable.length > 0 && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-300 dark:border-rose-800 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span className="flex-1">
                {unreadable.map(e => `“${viewHere(e)!.name}”`).join(', ')} can’t be read here any more, so {unreadable.length === 1 ? 'it' : 'they'} can’t
                be updated. Go back to Match and skip {unreadable.length === 1 ? 'it' : 'them'}, or import {unreadable.length === 1 ? 'it as a separate copy' : 'them as separate copies'}.
              </span>
              <button type="button" onClick={() => currentViews.forEach(q => { if (q.isError) void q.refetch() })}
                className="font-semibold underline underline-offset-2 hover:no-underline shrink-0">
                Try again
              </button>
            </div>
          )}
          <div className="rounded-2xl border border-glass-border divide-y divide-glass-border">
            {active.map(e => (
              <ReviewRow key={e.view.index} entry={e}
                workspaceId={viewHere(e)?.workspaceId ?? targets[e.view.source]?.workspaceId ?? null}
                where={e.action === 'update' ? `Update · ${e.strategy === 'merge' ? 'merge' : 'replace'}`
                  : e.action === 'overwrite' ? `Overwrite “${e.overwrite?.name}”` : `New in ${labelOf(targets[e.view.source])}`}
                sharedInBatch={!viewHere(e)
                  && (namesInBatch.get(`${targets[e.view.source]?.workspaceId}|${e.name.trim().toLowerCase()}`) ?? 0) > 1}
                environment={environment}
                onChange={(patch) => setEntry(e.view.index, patch)} />
            ))}
          </div>
        </div>
      )}
    </WizardShell>
  )
}

/** One view in the Review step: its name (flagged when it would duplicate one), and who sees it. */
function ReviewRow({ entry: e, workspaceId, where, sharedInBatch, environment, onChange }: {
  entry: Entry
  workspaceId: string | null
  where: string
  sharedInBatch: boolean
  environment?: string | null
  onChange: (patch: Partial<Entry>) => void
}) {
  const isNew = !viewHere(e)
  const name = useDebouncedValue(e.name.trim(), 300)
  const { data } = useQuery({
    queryKey: ['import-name-check', workspaceId, name],
    queryFn: () => listViews({ workspaceId: workspaceId!, search: name, limit: 20 }),
    enabled: isNew && !!workspaceId && name.length > 0,
    staleTime: 30_000,
  })
  const taken = new Set((data?.items ?? []).map(v => v.name.trim().toLowerCase()))
  const duplicate = isNew && name.length > 0 && (sharedInBatch || taken.has(name.toLowerCase()))
  const suggestion = duplicate
    ? [environment ? `${name} (from ${environment})` : null, `${name} (imported)`, `${name} 2`]
      .find((s): s is string => !!s && !taken.has(s.toLowerCase()))
    : undefined
  const rate = e.reconciled?.report.summary.matchRate

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <input value={e.name} onChange={(ev) => onChange({ name: ev.target.value })}
          aria-label={`Name for ${e.view.metadata.name}`}
          className={cn('flex-1 min-w-0 px-2 py-1.5 text-xs rounded-lg border bg-transparent text-ink outline-none focus:border-indigo-500',
            duplicate ? 'border-amber-500/50' : 'border-glass-border')} />
        <span className="text-[11px] text-ink-muted w-48 truncate" title={where}>{where}</span>
        {isNew ? (
          <select value={e.visibility} aria-label={`Who can see ${e.name}`}
            onChange={(ev) => onChange({ visibility: ev.target.value as Visibility })}
            className="text-[11px] rounded-lg border border-glass-border bg-canvas-elevated px-2 py-1 text-ink w-28">
            <option value="private">Only me</option>
            <option value="workspace">Workspace</option>
          </select>
        ) : <span className="w-28" />}
        <span className="text-xs font-bold tabular-nums w-12 text-right">{percent(rate, 0)}</span>
      </div>
      {duplicate && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          {sharedInBatch ? 'Another view in this file goes here under this name.' : 'A view with this name is already there.'}
          {suggestion && (
            <button type="button" onClick={() => onChange({ name: suggestion })}
              className="font-semibold underline underline-offset-2 hover:no-underline">
              Use “{suggestion}”
            </button>
          )}
        </p>
      )}
    </div>
  )
}

function ProgressList({ entries, onOpen, onOpenReview }: {
  entries: Entry[]
  onOpen: (viewId: string, branchId?: string | null) => void
  onOpenReview: (workspaceId: string, prId: string) => void
}) {
  return (
    <div className="max-w-2xl mx-auto space-y-2" aria-live="polite">
      {entries.map(e => (
        <div key={e.view.index} className={cn('flex items-center gap-3 rounded-xl border px-4 py-2.5',
          e.run.state === 'failed' ? 'border-rose-300 dark:border-rose-800' : 'border-glass-border')}>
          <span className={cn('w-6 h-6 rounded-full flex items-center justify-center shrink-0',
            e.run.state === 'done' ? 'bg-emerald-500 text-white'
              : e.run.state === 'failed' ? 'bg-rose-500 text-white'
                : e.run.state === 'running' ? 'bg-indigo-500 text-white' : 'bg-black/[0.06] dark:bg-white/[0.08]')}>
            {e.run.state === 'done' ? <Check className="w-3.5 h-3.5" />
              : e.run.state === 'failed' ? <X className="w-3.5 h-3.5" />
                : e.run.state === 'running' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-ink truncate">{e.name}</p>
            {e.run.state === 'failed' && <p className="text-[11px] text-rose-600 dark:text-rose-400 truncate" title={e.run.error}>{e.run.error}</p>}
            {e.run.state === 'done' && (
              <p className="text-[11px] text-ink-muted">
                {!e.run.branchId ? `v${e.run.version}`
                  : e.review?.state === 'sent' ? 'In review, live when its review request merges'
                    : 'In a draft, live when it’s published'}
                {' · '}{percent(e.run.matchRate)} matched · {e.run.verified ? 'integrity verified' : 'adjusted here'}
              </p>
            )}
            {e.review?.state === 'failed' && (
              <p className="text-[11px] text-rose-600 dark:text-rose-400 truncate" title={e.review.error}>
                Not submitted for review: {e.review.error}
              </p>
            )}
          </div>
          {e.review?.state === 'sending' && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500 shrink-0" aria-label="Submitting for review" />}
          {e.review?.state === 'sent' && e.review.prId && e.review.workspaceId && (
            <button type="button" onClick={() => onOpenReview(e.review!.workspaceId!, e.review!.prId!)}
              className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">
              Open review
            </button>
          )}
          {e.run.state === 'done' && e.run.viewId && (
            <button type="button" onClick={() => onOpen(e.run.viewId!, e.run.branchId)}
              className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">
              {e.run.branchId ? 'Open in draft' : 'Open'}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
