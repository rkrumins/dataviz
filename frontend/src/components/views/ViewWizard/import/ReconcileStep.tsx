/**
 * The Import journey's Match step: how the view in the file fits where it's going.
 *
 * Reconciles on arrival (the server looks up every entity the view places, once per data
 * source), shows the account, and lets the person decide what happens to whatever didn't match.
 * Their choices are projected on the score immediately; "Re-check" sends them to the server,
 * whose answer is authoritative and becomes the design the rest of the wizard edits.
 */
import { useEffect, useMemo } from 'react'
import { AlertTriangle, FastForward, Loader2, RefreshCw } from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import type { TransferTarget } from '@/services/viewTransferApiService'
import { ReconciliationPanel } from '@/features/view-transfer/reconcile/ReconciliationPanel'
import { resolutionCount, sameResolutions } from '@/features/view-transfer/reconcile/resolutions'
import { pluralize } from '@/features/view-transfer/format'
import { useImportSession } from './importSession'

export function ReconcileStep({ target, targetLabel, onSkipToReview }: {
  target: TransferTarget
  targetLabel: string
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

  const availableTypes = useMemo(() => ({
    entity: (schema?.entityTypes ?? []).map(t => ({ id: t.id, name: t.name ?? t.id })),
    relationship: (schema?.relationshipTypes ?? []).map(t => ({ id: t.id, name: t.name ?? t.id })),
  }), [schema])

  const dirty = !sameResolutions(session.resolutions, session.draft)
  const pendingCount = resolutionCount(session.draft)
  const environment = inspect?.bundle.generator.environment
  const sourceLabel = `${environment ? `${environment} · ` : ''}${view?.metadata.name ?? 'The file'}`

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

      <ReconciliationPanel
        reconciled={reconcile}
        applied={session.resolutions}
        draft={session.draft}
        onDraft={session.setDraft}
        onStrategy={session.targetView ? session.setStrategy : undefined}
        sourceLabel={sourceLabel}
        targetLabel={targetLabel}
        targetName={session.targetView?.name}
        availableTypes={availableTypes}
        exportedNames={view?.manifest.entities ?? {}}
      />

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
