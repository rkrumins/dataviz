/**
 * HandOnDraftForm — hand a draft to someone else: pick the person, choose whether the previous owner
 * stays on as a maintainer, and hand it on. Its owner does this in the draft's settings; a workspace
 * admin does it for a draft whose owner left (the leavers' panel). The server decides who may, and
 * who can own it (an active person who can edit the workspace's data sources); a refusal is shown
 * as it says.
 */
import { useState } from 'react'
import { ArrowRightLeft, Loader2, X } from 'lucide-react'
import { useAppNotifications } from '@/components/ui/notifications'
import { SubjectPicker, subjectKey, type Subject } from '@/components/serviceAccounts/SubjectPicker'
import { useTransferDraft } from '../hooks/useVersioning'

export function HandOnDraftForm({
  wsId, graphId, branchId, previousOwner, keepPreviousLabel = 'Stay on as a maintainer',
  keepPreviousByDefault = true, onDone,
}: {
  wsId: string
  graphId: string
  branchId: string
  /** Who owns it now: not offered as its next owner. */
  previousOwner?: string | null
  keepPreviousLabel?: string
  keepPreviousByDefault?: boolean
  onDone?: (to: string) => void
}) {
  const { notify } = useAppNotifications()
  const transfer = useTransferDraft(wsId, graphId)
  const [to, setTo] = useState<Subject | null>(null)
  const [keepPrevious, setKeepPrevious] = useState(keepPreviousByDefault)

  const handOn = async () => {
    if (!to) return
    try {
      await transfer.mutateAsync({ branchId, to: to.id, keepPrevious })
      notify('success', `${to.name} owns this draft now.`)
      onDone?.(to.id)
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Could not hand this draft on.')
    }
  }

  return to === null ? (
    <SubjectPicker
      label="New owner"
      types={['user']}
      exclude={previousOwner ? [subjectKey({ type: 'user', id: previousOwner })] : []}
      onPick={setTo}
    />
  ) : (
    <div className="rounded-lg border border-glass-border px-3 py-2.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink truncate">
          <span className="text-ink-muted">New owner:</span> {to.name}
        </p>
        <button onClick={() => setTo(null)} aria-label="Choose someone else"
          className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
        <input type="checkbox" checked={keepPrevious} onChange={(e) => setKeepPrevious(e.target.checked)}
          className="rounded border-glass-border" />
        {keepPreviousLabel}
      </label>
      <button
        onClick={handOn}
        disabled={transfer.isPending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm disabled:opacity-50"
      >
        {transfer.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRightLeft className="w-3.5 h-3.5" />}
        Hand on to {to.name}
      </button>
    </div>
  )
}
