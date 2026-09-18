/**
 * RollbackDialogs — the two rollback confirmations, in plain language:
 *
 * - RevertDialog: undo ONE published revision (git-revert). Later work is kept.
 *   When later revisions touched the same items the server 409s — the dialog
 *   morphs into an explanation and offers the escape hatch: "Restore to just
 *   before it instead" (which by definition cannot conflict).
 * - RestoreDialog: reset the graph to a chosen revision (point-in-time
 *   rollback). Shows the EXACT impact up front via the restore-preview
 *   endpoint. Both write a new revision — history is never rewritten.
 *
 * Build rules honoured: Backdrop rendered as a SIBLING of the pointer-events-
 * none wrapper (never inside AnimatePresence), CSS fade only (no exit
 * animations on portals), ink/canvas/glass tokens, DataHealthTab modal shape.
 */
import { useEffect, useState } from 'react'
import { History, Loader2, RotateCcw, TriangleAlert, Undo2, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { MergeConflictError } from '@/services/versioningApiService'
import { useRestoreCommit, useRestorePreview, useRevertCommit } from '../hooks/useVersioning'
import { kindMeta } from '../model/commitKind'
import { ownerName } from '../model/branchVocab'
import { NodeDiffBadge } from './NodeDiffBadge'

type CommitLike = Record<string, unknown>

const num = (v: unknown) => (typeof v === 'number' ? v : 0)

function CommitSummary({ commit, userNames }: { commit: CommitLike; userNames?: Record<string, string> }) {
  const kind = kindMeta(commit.kind)
  const stats = (commit.stats ?? {}) as Record<string, unknown>
  const actor = typeof commit.actor === 'string' && commit.actor
    ? ownerName(commit.actor, userNames)
    : 'system'
  return (
    <div className="mx-6 mb-4 rounded-xl border border-glass-border bg-canvas-overlay/40 px-4 py-3">
      <p className="text-sm text-ink font-medium leading-snug flex items-center gap-1.5 min-w-0">
        <span className="truncate">
          {(commit.message as string) || `${commit.kind ?? 'revision'} #${commit.commit_seq ?? ''}`}
        </span>
        <span className={cn('shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded', kind.cls)}>
          {kind.label}
        </span>
      </p>
      <p className="text-[11px] text-ink-muted mt-1 flex items-center gap-1.5 flex-wrap">
        <User className="w-3 h-3" />
        {actor}
        <span>·</span>
        <span>{timeAgo(commit.created_at as string)}</span>
        <span className="inline-flex items-center gap-1 ml-1">
          {num((stats as Record<string, unknown>).create) > 0 && <NodeDiffBadge status="added" count={num(stats.create)} />}
          {num(stats.update) > 0 && <NodeDiffBadge status="modified" count={num(stats.update)} />}
          {num(stats.delete) > 0 && <NodeDiffBadge status="removed" count={num(stats.delete)} />}
        </span>
      </p>
    </div>
  )
}

function ModalShell({
  open, onClose, titleId, children,
}: { open: boolean; onClose: () => void; titleId: string; children: React.ReactNode }) {
  const ref = useModalA11y(open, onClose)
  return (
    <>
      <Backdrop open={open} onClick={onClose} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
          <div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in pointer-events-auto outline-none"
          >
            {children}
          </div>
        </div>
      )}
    </>
  )
}

// ─── Revert ──────────────────────────────────────────────────────────────────

export function RevertDialog({
  open, commit, wsId, graphId, onClose, onRestoreInstead, userNames,
}: {
  open: boolean
  commit: CommitLike | null
  wsId: string
  graphId: string
  onClose: () => void
  /** Open the RestoreDialog targeting the commit just before this one (escape hatch). */
  onRestoreInstead?: (restoreTarget: CommitLike) => void
  /** actor id → display name (the commit log wrapper's map). */
  userNames?: Record<string, string>
}) {
  const { notify } = useAppNotifications()
  const revert = useRevertCommit(wsId, graphId)
  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>> | null>(null)

  useEffect(() => {
    if (!open) setConflicts(null) // fresh dialog every open
  }, [open])

  if (!commit) return null
  const commitId = commit.commit_id as string
  const parentId = commit.parent_commit_id as string | undefined

  const doRevert = () => {
    revert.mutate(
      { commitId },
      {
        onSuccess: (r) => {
          onClose()
          notify(
            'success',
            r.commitId
              ? 'Change undone — a new revision was added to history.'
              : 'Nothing to undo — the graph already matches.',
          )
        },
        onError: (err) => {
          if (err instanceof MergeConflictError) {
            setConflicts(err.conflicts)
            return
          }
          notify('error', err instanceof Error ? err.message : 'Could not undo this change.')
        },
      },
    )
  }

  const conflictedIds = (conflicts ?? [])
    .map((c) => String(c.entity_id ?? ''))
    .filter(Boolean)

  return (
    <ModalShell open={open} onClose={onClose} titleId="revert-dialog-title">
      {conflicts === null ? (
        <>
          <div className="px-6 pt-6 pb-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-500/10 flex items-center justify-center border border-rose-500/20 shrink-0">
              <Undo2 className="w-5 h-5 text-rose-500" />
            </div>
            <h3 id="revert-dialog-title" className="text-base font-semibold text-ink tracking-tight">Undo this change?</h3>
          </div>
          <CommitSummary commit={commit} userNames={userNames} />
          <p className="px-6 pb-5 text-[13px] text-ink-muted leading-relaxed">
            Everything this revision changed goes back to how it was.{' '}
            <span className="font-semibold text-ink">Later changes are kept.</span>{' '}
            This adds a new revision to history — nothing is rewritten.
          </p>
          <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors">
              Cancel
            </button>
            <button
              onClick={doRevert}
              disabled={revert.isPending}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-rose-500 to-red-600 hover:from-rose-600 hover:to-red-700 shadow-lg shadow-rose-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
            >
              {revert.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Undo2 className="w-4 h-4" />}
              Undo change
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="px-6 pt-6 pb-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center border border-amber-500/20 shrink-0">
              <TriangleAlert className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <h3 id="revert-dialog-title" className="text-base font-semibold text-ink tracking-tight">
              This change can't be undone on its own
            </h3>
          </div>
          <p className="px-6 pb-3 text-[13px] text-ink-muted leading-relaxed">
            {conflictedIds.length === 1 ? '1 item was' : `${conflictedIds.length} items were`} changed
            again by a later revision, so undoing just this one would lose that later work.
          </p>
          {conflictedIds.length > 0 && (
            <div className="mx-6 mb-4 rounded-xl border border-glass-border bg-canvas-overlay/40 px-4 py-2.5 space-y-1">
              {conflictedIds.slice(0, 5).map((id) => (
                <p key={id} className="text-[11px] font-mono text-ink-secondary truncate">{id}</p>
              ))}
              {conflictedIds.length > 5 && (
                <p className="text-[11px] text-ink-muted">+{conflictedIds.length - 5} more</p>
              )}
            </div>
          )}
          <p className="px-6 pb-5 text-[13px] text-ink-muted leading-relaxed">
            You can restore the graph to <span className="font-semibold text-ink">just before this change</span>{' '}
            instead — that also rolls back everything after it.
          </p>
          <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors">
              Cancel
            </button>
            {onRestoreInstead && parentId && (
              <button
                onClick={() => onRestoreInstead({ commit_id: parentId, message: 'the revision before this change', kind: 'checkpoint' })}
                className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-lg shadow-amber-500/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                <History className="w-4 h-4" />
                Restore to just before it instead
              </button>
            )}
          </div>
        </>
      )}
    </ModalShell>
  )
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export function RestoreDialog({
  open, commit, wsId, graphId, onClose, userNames,
}: {
  open: boolean
  commit: CommitLike | null
  wsId: string
  graphId: string
  onClose: () => void
  /** actor id → display name (the commit log wrapper's map). */
  userNames?: Record<string, string>
}) {
  const { notify } = useAppNotifications()
  const restore = useRestoreCommit(wsId, graphId)
  const commitId = (commit?.commit_id as string) ?? null
  const preview = useRestorePreview(wsId, graphId, commitId, open)

  if (!commit || !commitId) return null

  const doRestore = () => {
    restore.mutate(
      { commitId },
      {
        onSuccess: (r) => {
          onClose()
          notify(
            'success',
            r.commitId
              ? 'Graph restored — a new revision was added to history.'
              : 'Nothing to restore — the graph already matches this point.',
          )
        },
        onError: (err) =>
          notify('error', err instanceof Error ? err.message : 'Could not restore the graph.'),
      },
    )
  }

  const pv = preview.data
  const parts: string[] = []
  if (pv) {
    const n = pv.nodes, e = pv.edges
    if (n.update) parts.push(`${n.update.toLocaleString()} item${n.update === 1 ? '' : 's'} updated`)
    if (n.delete) parts.push(`${n.delete.toLocaleString()} removed`)
    if (n.create) parts.push(`${n.create.toLocaleString()} brought back`)
    const edgeTouched = e.create + e.update + e.delete
    if (edgeTouched) parts.push(`${edgeTouched.toLocaleString()} connection${edgeTouched === 1 ? '' : 's'} adjusted`)
  }

  return (
    <ModalShell open={open} onClose={onClose} titleId="restore-dialog-title">
      <div className="px-6 pt-6 pb-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center border border-amber-500/20 shrink-0">
          <History className="w-5 h-5 text-amber-600 dark:text-amber-400" />
        </div>
        <h3 id="restore-dialog-title" className="text-base font-semibold text-ink tracking-tight">Restore the graph to this point?</h3>
      </div>
      <CommitSummary commit={commit} userNames={userNames} />
      <div className="px-6 pb-3 text-[13px] text-ink-muted leading-relaxed min-h-[2.5rem]">
        {preview.isLoading ? (
          <span className="inline-flex items-center gap-2 text-ink-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Working out the exact impact…
          </span>
        ) : pv?.approximate ? (
          <>
            Rolls back{' '}
            <span className="font-semibold text-ink">
              {pv.commitsUndone.toLocaleString()} later revision{pv.commitsUndone === 1 ? '' : 's'}
            </span>
            , affecting roughly{' '}
            <span className="font-semibold text-ink">
              {(pv.touchedEstimate ?? 0).toLocaleString()} items
            </span>
            . This is a big change — it may take a few minutes.
          </>
        ) : pv ? (
          pv.commitsUndone === 0 && parts.length === 0 ? (
            <>The graph already matches this point — restoring would change nothing.</>
          ) : (
            <>
              Rolls back{' '}
              <span className="font-semibold text-ink">
                {pv.commitsUndone.toLocaleString()} later revision{pv.commitsUndone === 1 ? '' : 's'}
              </span>
              {parts.length > 0 && <> — {parts.join(', ')}</>}.
            </>
          )
        ) : (
          <>Rolls back everything after this revision.</>
        )}
      </div>
      <p className="px-6 pb-5 text-[12px] text-ink-muted/80 leading-relaxed">
        A new restore revision is added. <span className="font-medium text-ink-secondary">Full history is kept</span> — you can roll forward again later.
      </p>
      <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
        <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors">
          Cancel
        </button>
        <button
          onClick={doRestore}
          disabled={restore.isPending || preview.isLoading}
          className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-lg shadow-amber-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
        >
          {restore.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
          Restore
        </button>
      </div>
    </ModalShell>
  )
}
