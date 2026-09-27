/**
 * usePropertyOpCompletion — word when a property operation on the draft finishes: what it did,
 * with the way to review it, and the draft's reads refreshed — every versioning read, and the
 * canvas's graph reads. An operation never seen running (it finished before this was mounted)
 * isn't announced.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useAppNotifications } from '@/components/ui/notifications'
import type { PropertyOpList } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'

import { isLive, opLabel, opOutcome } from '../model/propertyOps'
import { VERSIONING_KEYS } from './useVersioning'

export function usePropertyOpCompletion(list: PropertyOpList | undefined, onReview: () => void) {
  const qc = useQueryClient()
  const bumpMainEpoch = useBranchStore((s) => s.bumpMainEpoch)
  const { notify } = useAppNotifications()
  const live = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!list) return
    const finished = list.ops.filter((op) => live.current.has(op.jobId) && !isLive(op))
    live.current = new Set(list.ops.filter(isLive).map((op) => op.jobId))
    if (finished.length === 0) return
    void qc.invalidateQueries({ queryKey: VERSIONING_KEYS.all })
    bumpMainEpoch()
    for (const op of finished) {
      const label = op.kind === 'undo' ? `Undo: ${opLabel(op.op)}` : opLabel(op.op)
      if (op.status === 'completed') {
        notify('success', `${label} — ${opOutcome(op)}`, { label: 'Review changes', onClick: onReview })
      } else if (op.status === 'failed') {
        notify('error', `${label} didn't finish: ${op.error ?? 'it failed'}`)
      } else {
        notify('info', `${label} stopped${op.summary ? ` — ${opOutcome(op)}` : ''}`)
      }
    }
  }, [list, qc, bumpMainEpoch, notify, onReview])
}
