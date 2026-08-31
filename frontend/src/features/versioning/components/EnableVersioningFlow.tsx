/**
 * EnableVersioningFlow — the guided "turn on version control" modal.
 *
 * Enabling copies the entire graph into version history. That is a real, minutes-long
 * operation on a large model, so the user gets told what they're getting, how big the
 * copy is, and what happens while it runs — before they commit to it. (The old flow
 * was a bare button that fired a blocking request and showed a spinner.)
 *
 * Backdrop is a SIBLING of the pointer-events-none wrapper and never lives inside
 * AnimatePresence — the app's strand-proof modal invariant.
 */
import { useState } from 'react'
import { Check, GitBranch, History, Loader2, ShieldCheck, Sparkles, X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { useBootstrapGraph } from '../hooks/useVersioning'

const BENEFITS = [
  {
    Icon: GitBranch,
    title: 'Edit safely in drafts',
    body: 'Your changes stay private until you publish them. The live graph is never touched by a work-in-progress.',
  },
  {
    Icon: ShieldCheck,
    title: 'Review before anything ships',
    body: 'Raise a change for review, see exactly what moves, resolve conflicts, then merge.',
  },
  {
    Icon: History,
    title: 'Full history — and a way back',
    body: 'Every publish is a revision you can inspect, undo, or roll the whole graph back to.',
  },
]

export function EnableVersioningFlow({
  open, onClose, wsId, dataSourceId, itemCount,
}: {
  open: boolean
  onClose: () => void
  wsId: string
  dataSourceId: string
  /** Best-known size of the source graph (nodes + edges), for the pre-flight line. */
  itemCount?: number | null
}) {
  const { notify } = useAppNotifications()
  const bootstrap = useBootstrapGraph(wsId)
  const [started, setStarted] = useState(false)

  const start = () => {
    setStarted(true)
    bootstrap.mutate(dataSourceId, {
      onSuccess: (res) => {
        onClose()
        notify(
          'success',
          res.alreadyEnabled
            ? 'Version control is already on for this data source.'
            : 'Copying your graph into version history — you can keep working while it runs.',
        )
      },
      onError: (e) => {
        setStarted(false)
        notify('error', e instanceof Error ? e.message : 'Could not start.')
      },
    })
  }

  const size = typeof itemCount === 'number' && itemCount > 0
    ? `about ${itemCount.toLocaleString()} items`
    : 'everything currently in this graph'

  const dialogRef = useModalA11y(open, onClose)

  return (
    <>
      <Backdrop open={open} onClick={onClose} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="enable-vc-title"
            tabIndex={-1}
            className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-lg mx-4 overflow-hidden animate-fade-in pointer-events-auto outline-none"
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute top-4 right-4 p-1.5 rounded-lg text-ink-muted/60 hover:text-ink hover:bg-canvas-overlay transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="px-6 pt-6 pb-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/15 to-violet-600/10 flex items-center justify-center border border-indigo-500/20 shrink-0">
                <Sparkles className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 id="enable-vc-title" className="text-base font-semibold text-ink tracking-tight">Turn on version control</h3>
                <p className="text-[12px] text-ink-muted">Drafts, reviews and full history for this data source.</p>
              </div>
            </div>

            <ul className="px-6 pb-1 space-y-3">
              {BENEFITS.map(({ Icon, title, body }) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="mt-0.5 w-7 h-7 rounded-lg bg-accent-lineage/10 border border-accent-lineage/20 flex items-center justify-center shrink-0">
                    <Icon className="w-3.5 h-3.5 text-accent-lineage" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink leading-snug">{title}</span>
                    <span className="block text-[12px] text-ink-muted leading-snug">{body}</span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="mx-6 my-4 rounded-xl border border-glass-border bg-canvas-overlay/40 px-4 py-3">
              <p className="text-[12px] text-ink-secondary leading-relaxed">
                We'll copy <span className="font-semibold text-ink">{size}</span> into version history and
                check every item against the source before switching it on.
              </p>
              <p className="text-[11px] text-ink-muted mt-1.5 leading-relaxed">
                <span className="inline-flex items-center gap-1 font-medium text-ink-muted">
                  <Check className="w-3 h-3" /> You can keep using this graph while it runs
                </span>
                {' · '}
                large models can take a few minutes · nothing changes until the check passes.
              </p>
            </div>

            <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors"
              >
                Not now
              </button>
              <button
                onClick={start}
                disabled={started || bootstrap.isPending}
                className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-lg shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 disabled:hover:scale-100"
              >
                {started || bootstrap.isPending
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Sparkles className="w-4 h-4" />}
                Turn on version control
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
