/**
 * IncomingChangesSheet — "here's what just came in".
 *
 * A pull used to end in a notification that said "Pulled the latest changes from main." and nothing else:
 * the user took someone else's work into their branch without ever being shown what it was. (Worse,
 * `alreadyUpToDate` never reached the client because of a casing mismatch, so the notification said that
 * even when nothing had arrived.)
 *
 * This shows the arriving work in the SAME visual language as every other diff on the canvas —
 * emerald added / amber modified / rose removed (`useDiffDecoration`) — reusing `ChangesPanel`, with
 * the upstream authors named, because "who changed this under me" is the first thing you want to know.
 *
 * NO AnimatePresence/exit: a portaled exit transition strands an invisible click-blocker over the
 * canvas — a freeze class that has shipped here three times.
 */
import { createPortal } from 'react-dom'
import { ArrowDownToLine, X, Loader2, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { Backdrop } from '@/components/ui/Backdrop'
import type { IncomingChanges } from '@/services/versioningApiService'
import { useDiffWindow } from '../hooks/useVersioning'
import { fromIncomingDiff } from '../model/changeAdapters'
import { ownerName } from '../model/branchVocab'
import { ChangesPanel, ChangeCountChips } from './ChangesPanel'

export function IncomingChangesSheet({
  wsId,
  graphId,
  incoming,
  userNames,
  onClose,
}: {
  wsId: string
  graphId: string
  /** Self-describing: carries the branch (main) AND the seq window that arrived, so this needs no
   *  client state — a reviewer pulling from the Reviews inbox has no canvas, hence no branchStore. */
  incoming: IncomingChanges
  userNames?: Record<string, string>
  onClose: () => void
}) {
  const diffQ = useDiffWindow(wsId, graphId, incoming.branchId, incoming.fromSeq, incoming.toSeq)
  const changeSet = diffQ.data ? fromIncomingDiff(diffQ.data, `pull_${incoming.toSeq}`) : null

  const n = incoming.commitCount
  const authors = incoming.contributors.map((c) => ownerName(c, userNames)).filter(Boolean)

  return createPortal(
    <>
      <Backdrop open onClick={onClose} zClassName="z-[110]" className="bg-black/40 backdrop-blur-sm" />
      <div className="fixed inset-0 z-[110] flex items-center justify-center pointer-events-none p-4">
        <div
          className={cn(
            'relative w-full max-w-2xl max-h-[80vh] flex flex-col pointer-events-auto animate-fade-in',
            'bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border overflow-hidden',
          )}
        >
          <div className="px-6 pt-6 pb-4 flex items-start gap-3 border-b border-glass-border">
            <div className="w-10 h-10 rounded-xl bg-teal-500/10 border border-teal-500/25 flex items-center justify-center shrink-0">
              <ArrowDownToLine className="w-5 h-5 text-teal-600 dark:text-teal-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-ink tracking-tight">
                You’re up to date — here’s what came in
              </h3>
              <p className="text-[11px] text-ink-muted mt-1 leading-relaxed">
                {n} {n === 1 ? 'change' : 'changes'} published to this data source since you started
                {authors.length > 0 && (
                  <>
                    {' '}by{' '}
                    <span className="inline-flex items-center gap-1 font-medium text-ink">
                      <Users className="w-3 h-3" />
                      {authors.join(', ')}
                    </span>
                  </>
                )}
                . Your own edits were kept and rebased on top.
              </p>
            </div>
            <HoverTip className="inline-flex shrink-0" label="Close this summary">
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1.5 rounded-lg hover:bg-canvas-overlay transition-colors shrink-0"
              >
                <X className="w-4 h-4 text-ink-muted" />
              </button>
            </HoverTip>
          </div>

          {changeSet && changeSet.changes.length > 0 && (
            <div className="px-6 py-3 border-b border-glass-border bg-canvas-overlay/30 flex items-center gap-2">
              <span className="text-xs text-ink-muted">Arrived</span>
              <ChangeCountChips changeSet={changeSet} />
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
            {diffQ.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-ink-muted text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading what changed…
              </div>
            ) : changeSet ? (
              <ChangesPanel changeSet={changeSet} emptyHint="No entity changes came in — only metadata." />
            ) : (
              <p className="text-sm text-ink-muted py-10 text-center">Couldn’t load the incoming changes.</p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-glass-border flex justify-end bg-canvas-overlay/40">
            <button
              onClick={onClose}
              className={cn(
                'px-5 py-2 rounded-xl text-sm font-medium text-white transition-all',
                'bg-gradient-to-r from-teal-500 to-emerald-600 hover:from-teal-600 hover:to-emerald-700',
                'shadow-lg shadow-teal-500/20 hover:scale-[1.02] active:scale-[0.98]',
              )}
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
