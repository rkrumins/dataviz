/**
 * DraftLevelDialog — confirms making a draft public or private, saying what changes first.
 *
 * Made private: only its owner, the people added to it and the people on its review keep it; the
 * dialog names whose unsaved edits are saved first, under their names (the visibility-impact
 * preview), so nobody's work is lost on the way. When some of those edits clash with the draft the
 * server leaves the level as it was, and the dialog says whose they are. Made public: everyone who
 * can see the data source sees it, and everyone who can edit it can change it.
 *
 * Backdrop rendered as a sibling of the pointer-events-none wrapper, CSS fade only (no exit
 * animations on portals), as the rollback dialogs do.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Globe2, Loader2, Lock, TriangleAlert } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { StagedChangesUnsavedError, type DraftLevel } from '@/services/versioningApiService'
import { useDraftLevelImpact, useSetDraftLevel } from '../hooks/useVersioning'
import { ownerName } from '../model/branchVocab'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

export function DraftLevelDialog({
  wsId, graphId, branchId, to, onClose, onChanged,
}: {
  wsId: string
  graphId: string
  branchId: string
  /** The level to change to; null: closed. */
  to: DraftLevel | null
  onClose: () => void
  onChanged?: (level: DraftLevel) => void
}) {
  const { notify } = useAppNotifications()
  const [refusal, setRefusal] = useState<string | null>(null)
  const close = () => { setRefusal(null); onClose() }    // a fresh dialog every open
  const ref = useModalA11y(!!to, close)
  const setLevel = useSetDraftLevel(wsId, graphId)
  const impactQ = useDraftLevelImpact(wsId, graphId, branchId, to === 'private' ? to : null)

  if (!to) return null
  const names = impactQ.data?.userNames
  const saved = impactQ.data?.saved ?? []
  const titleId = 'draft-level-dialog-title'
  const isPrivate = to === 'private'

  const confirm = async () => {
    setRefusal(null)
    try {
      await setLevel.mutateAsync({ branchId, visibility: to })
      notify('success', isPrivate ? 'This draft is private now.' : 'This draft is public now.')
      onChanged?.(to)
      close()
    } catch (e) {
      if (e instanceof StagedChangesUnsavedError) {
        const who = e.actors.map((a) => ownerName(a, names)).join(', ')
        setRefusal(`${who}’s unsaved changes clash with the draft, so they couldn’t be saved first. `
          + 'Ask them to save or discard them, then try again. Nothing has changed.')
        return
      }
      setRefusal(e instanceof Error ? e.message : 'Could not change who can see this draft.')
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
            <div className={isPrivate
              ? 'w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20 shrink-0'
              : 'w-10 h-10 rounded-xl bg-sky-500/10 flex items-center justify-center border border-sky-500/20 shrink-0'}>
              {isPrivate ? <Lock className="w-5 h-5 text-violet-500" /> : <Globe2 className="w-5 h-5 text-sky-500" />}
            </div>
            <h3 id={titleId} className="text-base font-semibold text-ink tracking-tight">
              {isPrivate ? 'Make this draft private?' : 'Make this draft public?'}
            </h3>
          </div>

          <p className="px-6 pb-4 text-[13px] text-ink-muted leading-relaxed">
            {isPrivate
              ? 'Only you, the people added to it and the people on its review will see it. Everyone else who could see or change it loses access.'
              : 'Everyone who can see this data source will see this draft, and everyone who can edit it will be able to change it.'}
          </p>

          {isPrivate && (impactQ.isLoading ? (
            <div className="mx-6 mb-4 flex items-center gap-2 text-xs text-ink-muted">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking for unsaved changes…
            </div>
          ) : saved.length > 0 && (
            <div className="mx-6 mb-4 rounded-xl border border-glass-border bg-canvas-overlay/40 px-4 py-3">
              <p className="text-[12px] font-medium text-ink mb-1.5">Saved first, under their names:</p>
              <ul className="space-y-1">
                {saved.map((s) => (
                  <li key={s.actor} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="text-ink truncate">{ownerName(s.actor, names)}</span>
                    <span className="text-ink-muted shrink-0">{plural(s.changes, 'unsaved change')}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {refusal && (
            <div role="alert" className="mx-6 mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-700 dark:text-amber-400">
              <TriangleAlert className="w-4 h-4 shrink-0 mt-px" />
              <span>{refusal}</span>
            </div>
          )}

          <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-3 bg-canvas-overlay/40">
            <button onClick={close} className="px-4 py-2 rounded-xl text-sm font-medium text-ink hover:bg-canvas-overlay transition-colors">
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={setLevel.isPending || (isPrivate && impactQ.isLoading)}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm transition-all disabled:opacity-60"
            >
              {setLevel.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {isPrivate ? 'Make private' : 'Make public'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
