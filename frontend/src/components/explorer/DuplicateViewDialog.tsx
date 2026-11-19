/**
 * DuplicateViewDialog — a proper copy of a view, made by the server (see viewDuplicateApi): its
 * name (at first "Copy of …") and who can see it (at first only you), then the copy opens.
 *
 * What a copy is depends on what the view is made from, and the dialog says which: an ordinary
 * view's layout is copied; a view made from a query is made again from the same query, working
 * its members out afresh; a subset keeps its search. A copy the server won't make is said in
 * plain words, and the dialog stays.
 */
import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Copy, Loader2, X } from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { cn } from '@/lib/utils'
import { VISIBILITY_ICON, visibilityDescription, visibilityLabel } from '@/lib/viewVisibility'
import { duplicateRefusal, duplicateView } from '@/services/viewDuplicateApi'

import type { MadeFrom } from './madeFrom'

const WHO: Array<'private' | 'workspace'> = ['private', 'workspace']

/** What the copy will be, by what the view is made from. */
function whatItCopies(madeFrom: MadeFrom | null): string {
  if (madeFrom?.kind === 'query') {
    return 'The copy is made from the same query and layers. Its members are worked out afresh, so it may take a moment to fill in.'
  }
  if (madeFrom?.kind === 'subset') return 'The copy keeps its search, and finds its matches in the same view.'
  return 'The copy starts with this view’s layers, placements and settings.'
}

export function DuplicateViewDialog({ viewId, viewName, madeFrom, onClose }: {
  viewId: string
  viewName: string
  madeFrom: MadeFrom | null
  onClose: () => void
}) {
  const [name, setName] = useState(`Copy of ${viewName}`)
  const [visibility, setVisibility] = useState<'private' | 'workspace'>('private')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const { notify } = useAppNotifications()
  const canCopy = name.trim().length > 0 && !busy

  const handleCopy = useCallback(async () => {
    if (!canCopy) return
    setBusy(true)
    setError(null)
    try {
      const { view, membership } = await duplicateView(viewId, { name: name.trim(), visibility })
      notify('success', membership?.status === 'updating'
        ? `“${view.name}” made — working out its members`
        : `“${view.name}” made`)
      // Open the copy first: closing unmounts this dialog.
      navigate(`/views/${view.id}`)
      onClose()
    } catch (err) {
      setError(duplicateRefusal(err))
      setBusy(false)
    }
  }, [canCopy, viewId, name, visibility, notify, onClose, navigate])

  const handleClose = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  return createPortal(
    <>
      <Backdrop open onClick={handleClose} zClassName="z-[80]" className="bg-black/60" />
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="duplicate-view-title"
          onClick={e => e.stopPropagation()}
          className="pointer-events-auto w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-lg shadow-black/20 overflow-hidden"
        >
          <div className="flex items-center gap-3.5 px-6 pt-6 pb-4">
            <div className="w-11 h-11 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/20 flex items-center justify-center">
              <Copy className="w-5 h-5 text-indigo-500" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 id="duplicate-view-title" className="text-lg font-bold text-slate-900 dark:text-white">Duplicate view</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{viewName}</p>
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close"
              className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="px-6 pb-5 space-y-4">
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{whatItCopies(madeFrom)}</p>

            <label className="block">
              <span className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">Name</span>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleCopy() }}
                autoFocus
                className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-sm font-medium text-slate-900 dark:text-white outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-500/10"
              />
            </label>

            <fieldset>
              <legend className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">Who can see it</legend>
              <div className="space-y-2">
                {WHO.map(tier => {
                  const Icon = VISIBILITY_ICON[tier]
                  const active = visibility === tier
                  return (
                    <button
                      key={tier}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setVisibility(tier)}
                      className={cn(
                        'w-full flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border-2 text-left transition-colors duration-150',
                        active ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20' : 'border-slate-200 dark:border-slate-700 hover:border-slate-300',
                      )}
                    >
                      <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', active ? 'text-indigo-500' : 'text-slate-400')} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-800 dark:text-slate-200">{visibilityLabel(tier)}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400 leading-snug">{visibilityDescription(tier)}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </fieldset>

            {error && (
              <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
            <button
              type="button"
              onClick={handleClose}
              disabled={busy}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCopy()}
              disabled={!canCopy}
              className={cn(
                'px-5 py-2.5 rounded-xl text-sm font-semibold transition-colors duration-150 flex items-center gap-2',
                canCopy ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed',
              )}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Copy className="w-3.5 h-3.5" />}
              {busy ? 'Duplicating…' : 'Duplicate'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}
