/**
 * The Import journey's Match step: how the view in the file fits where it's going.
 *
 * Reconciles on arrival (the server looks up every entity the view places, once per data
 * source), shows the account, and lets the person decide what happens to whatever didn't match.
 * Their choices are projected on the score immediately; "Re-check" sends them to the server,
 * whose answer is authoritative and becomes the design the rest of the wizard edits. When the
 * ontology here isn't the one the view was exported with, it says so.
 */
import { useEffect } from 'react'
import { AlertTriangle, FastForward, Loader2, RefreshCw } from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import type { TransferTarget } from '@/services/viewTransferApiService'
import { hasOntologyDrifted } from '@/components/schema/OntologyDriftBanner'
import { ReconciliationPanel } from '@/features/view-transfer/reconcile/ReconciliationPanel'
import type { EntitySearchScope } from '@/features/view-transfer/reconcile/EntitySearchPicker'
import { resolutionCount, sameResolutions } from '@/features/view-transfer/reconcile/resolutions'
import { pluralize } from '@/features/view-transfer/format'
import { useImportSession } from './importSession'

export function ReconcileStep({ target, targetLabel, searchScope, onSkipToReview }: {
  target: TransferTarget
  targetLabel: string
  /** The data source (and draft) the view goes into: where a remap searches. */
  searchScope?: EntitySearchScope | null
  onSkipToReview?: () => void
}) {
  const session = useImportSession()!
  const schema = useSchemaStore(s => s.schema)
  const { reconcile, reconciling, reconcileError, view, inspect } = session
  const targetKey = JSON.stringify(target)

  // Check on arrival, and again whenever the choices that shape the result were reset.
  useEffect(() => {
    if (!reconcile && !reconciling && !reconcileError) void session.runReconcile(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconcile, reconciling, reconcileError, targetKey])

  const dirty = !sameResolutions(session.resolutions, session.draft)
  const pendingCount = resolutionCount(session.draft)
  const environment = inspect?.bundle.generator.environment
  const sourceLabel = `${environment ? `${environment} · ` : ''}${view?.metadata.name ?? 'The file'}`
  // Both sides digest the ontology the same way (ContextEngine), so unequal means different.
  const drifted = hasOntologyDrifted(view ? inspect?.bundle.sources[view.source]?.ontology.digest : null, schema?.ontologyDigest)

  if (!reconcile) {
    return (
      <div className="py-16 flex flex-col items-center gap-4 text-center">
        {reconcileError ? (
          <>
            <span className="w-12 h-12 rounded-2xl bg-rose-500/10 text-rose-500 flex items-center justify-center"><AlertTriangle className="w-6 h-6" /></span>
            <p className="text-sm font-semibold text-ink">The view couldn’t be checked here</p>
            <p className="text-xs text-ink-muted max-w-md">{reconcileError}</p>
            <button type="button" onClick={() => void session.runReconcile(target)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-500 text-white hover:bg-indigo-600">
              <RefreshCw className="w-4 h-4" /> Try again
            </button>
          </>
        ) : (
          <>
            <div className="relative w-16 h-16">
              <div className="absolute inset-0 rounded-full bg-indigo-500/10 animate-ping" />
              <div className="relative w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-950/40 flex items-center justify-center">
                <Loader2 className="w-7 h-7 text-indigo-500 animate-spin" />
              </div>
            </div>
            <p className="text-sm font-semibold text-ink">Checking every entity the view places…</p>
            <p className="text-[11px] text-ink-muted">
              {(view?.manifest.counts?.assignments ?? 0).toLocaleString()} placements against {targetLabel}
            </p>
          </>
        )}
      </div>
    )
  }

  const verdict = reconcile.report.summary.verdict
  const unchecked = reconcile.report.summary.entities.unknown
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl font-bold text-ink">How it fits here</h3>
          <p className="text-sm text-ink-muted mt-0.5">
            Everything the view points at, looked up in {targetLabel}. Decide what happens to anything that didn’t match.
          </p>
        </div>
        {verdict === 'ready' && !dirty && onSkipToReview && (
          <button type="button" onClick={onSkipToReview}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10">
            <FastForward className="w-3.5 h-3.5" /> Skip to review
          </button>
        )}
      </div>

      {drifted && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
          The ontology here isn’t the one this view was built with{environment ? ` in ${environment}` : ''}. Its types are
          checked against this one, and any this one lacks are listed below.
        </p>
      )}

      <ReconciliationPanel
        reconciled={reconcile}
        applied={session.resolutions}
        draft={session.draft}
        onDraft={session.setDraft}
        onStrategy={session.targetView ? session.setStrategy : undefined}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
        targetName={session.targetView?.name}
        exportedNames={view?.manifest.entities ?? {}}
        searchScope={searchScope}
      />

      {/* A lookup that failed is worth another try: those entities are neither found nor missing. */}
      {unchecked > 0 && !dirty && !reconciling && (
        <div className="flex items-center gap-3 rounded-xl border border-glass-border px-4 py-3">
          <p className="text-xs text-ink flex-1">
            {pluralize(unchecked, 'entity', 'entities')} couldn’t be checked because the lookup failed, so {unchecked === 1 ? 'it counts' : 'they count'} as neither found nor missing.
          </p>
          <button type="button" onClick={() => void session.runReconcile(target)}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600">
            <RefreshCw className="w-3.5 h-3.5" /> Check again
          </button>
        </div>
      )}

      {(dirty || reconciling) && (
        <div className="sticky bottom-0 flex items-center gap-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-canvas-elevated px-4 py-3 shadow-lg">
          <p className="text-xs text-ink flex-1">
            {reconciling ? 'Checking your choices…'
              : `${pluralize(pendingCount, 'choice')} made. Re-check to see the result and continue.`}
          </p>
          <button type="button" onClick={() => session.setDraft(session.resolutions)} disabled={reconciling}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40">
            Undo
          </button>
          <button type="button" disabled={reconciling} onClick={() => void session.runReconcile(target, { applyDraft: true })}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-60">
            {reconciling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Re-check
          </button>
        </div>
      )}
    </div>
  )
}
