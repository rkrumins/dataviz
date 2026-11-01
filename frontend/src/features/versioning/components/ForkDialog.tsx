/**
 * ForkDialog — fork a data source's graph: a name, and the fork is made — a graph and a data source
 * of its own, labelled after this one and the name, that reads this graph and proposes its changes
 * back as a review. A refusal (the fork cap, paused editing, forks turned off) is said in the
 * server's words, and the dialog stays open.
 *
 * Backdrop rendered as a sibling of the pointer-events-none wrapper, CSS fade only (no exit
 * animations on portals), as the rollback dialogs do.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitFork, TriangleAlert } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button } from '@/components/ui/Button'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { useCreateFork } from '../hooks/useVersioning'

export function ForkDialog({ wsId, graphId, open, onClose }: {
  wsId: string
  /** The graph to fork. */
  graphId: string
  open: boolean
  onClose: () => void
}) {
  const { notify } = useAppNotifications()
  const create = useCreateFork(wsId, graphId)
  const [name, setName] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  // Ref-stable close: the a11y hook re-focuses the panel whenever its callback changes identity,
  // which would take the focus out of the name field. The ref is updated after each render.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  const close = useCallback(() => {                                    // a fresh dialog every open
    setName(''); setRefusal(null); onCloseRef.current()
  }, [])
  const ref = useModalA11y(open, close)

  if (!open) return null
  const titleId = 'fork-dialog-title'

  const submit = async () => {
    setRefusal(null)
    try {
      await create.mutateAsync({ name })
      notify('success', 'Fork created — it’s in the Forks list.')
      close()
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : 'Could not fork this graph.')
    }
  }

  return createPortal(
    <>
      <Backdrop open onClick={close} zClassName="z-[100]" className="bg-black/40 backdrop-blur-sm" />
      <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="relative bg-canvas-elevated rounded-2xl shadow-glass-lg border border-glass-border w-full max-w-md mx-4 overflow-hidden animate-fade-in pointer-events-auto outline-none"
        >
          <div className="px-6 pt-6 pb-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shrink-0">
              <GitFork className="w-5 h-5 text-indigo-500" />
            </div>
            <h3 id={titleId} className="text-base font-semibold text-ink tracking-tight">Fork this graph</h3>
          </div>

          <p className="px-6 pb-4 text-[13px] text-ink-muted leading-relaxed">
            A fork is a copy of this graph to work in, with its own drafts and history. It takes this graph’s
            newer changes with Update from parent, and proposes its own back as a review.
          </p>

          <form className="px-6 pb-4 space-y-1" onSubmit={(e) => { e.preventDefault(); void submit() }}>
            <label htmlFor="fork-dialog-name" className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">Name</label>
            <input
              id="fork-dialog-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="e.g. Q3 restructure"
              className="w-full rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/40"
            />
            <p className="text-[11px] text-ink-muted">
              Its data source is named after this one and this name; left blank, “Fork” and the end of its id.
            </p>
          </form>

          {refusal && (
            <div role="alert" className="mx-6 mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-px" />
              <span>{refusal}</span>
            </div>
          )}

          <div className="px-6 py-4 border-t border-glass-border/60 flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={create.isPending}>Cancel</Button>
            <Button variant="primary" leftIcon={GitFork} loading={create.isPending} onClick={() => { void submit() }}>
              Create fork
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
