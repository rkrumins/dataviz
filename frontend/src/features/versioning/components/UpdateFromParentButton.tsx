/**
 * UpdateFromParentButton — take the parent's changes into a fork, with in-place conflict resolution,
 * as PullLatestButton does for a draft: it owns the update → conflicts → ConflictResolver → update
 * again loop, so each call site is one line. A large update runs as a job on the server; the button
 * says it is updating until the job ends, as a publish's button does.
 *
 * What both changed is resolved from the fork's own values the refusal hands back for just those
 * entities (`seeds`). Only the first hundred of a job's conflicts come back: the rest come with the
 * next update, once these are settled.
 */
import { useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { ForkUpdateConflictsError, type ResolutionMap, type UpdateFromParentResult } from '@/services/versioningApiService'
import { ConflictResolver } from '@/features/reviews/components/ConflictResolver'
import { useUpdateFromParent } from '../hooks/useVersioning'

export function UpdateFromParentButton({ wsId, forkGraphId, onUpdated, className }: {
  wsId: string
  /** The fork's graph. */
  forkGraphId: string
  /** The fork has taken its parent's changes (or had none to take). */
  onUpdated?: (res: UpdateFromParentResult) => void
  className?: string
}) {
  const { notify } = useAppNotifications()
  const update = useUpdateFromParent(wsId, forkGraphId)
  const [conflicts, setConflicts] = useState<Array<Record<string, unknown>> | null>(null)
  /** entityId → the fork's own value of each conflicting entity, to seed its resolution. */
  const [seeds, setSeeds] = useState<Record<string, Record<string, unknown> | undefined>>({})
  const [error, setError] = useState<string | null>(null)

  const run = (resolutions?: ResolutionMap) => {
    update.mutate(
      { resolutions },
      {
        onSuccess: (res) => {
          setConflicts(null); setError(null)
          onUpdated?.(res)
          if (res.upToDate) {
            notify('info', 'Already up to date with its parent.')
          } else {
            notify('success', res.wrote > 0
              ? `Updated from its parent: ${res.wrote.toLocaleString()} change${res.wrote === 1 ? '' : 's'} merged.`
              : 'Updated from its parent.')
          }
        },
        onError: (e) => {
          if (e instanceof ForkUpdateConflictsError) {
            setConflicts(e.conflicts)
            setSeeds(Object.fromEntries(Object.entries(e.seeds).map(([k, v]) => [k, v ?? undefined])))
            setError(e.total && e.total > e.conflicts.length
              ? `Showing the first ${e.conflicts.length} of ${e.total.toLocaleString()} conflicts: the rest come once these are settled.`
              : resolutions ? 'Some fields still conflict — adjust and retry.' : null)
            return
          }
          if (conflicts) setError((e as Error).message)
          else notify('error', (e as Error).message)
        },
      },
    )
  }

  return (
    <>
      <Button
        size="sm" variant="secondary" leftIcon={ArrowDownToLine} loading={update.isPending}
        onClick={() => run()} className={className}
        title="Take the parent’s changes into this fork — what both changed is shown before anything is written"
      >
        {update.isPending ? 'Updating…' : 'Update from parent'}
      </Button>

      {conflicts && (
        <ConflictResolver
          conflicts={conflicts}
          seeds={seeds}
          busy={update.isPending}
          error={error}
          onCancel={() => { setConflicts(null); setError(null) }}
          onResolve={(resolutions) => run(resolutions)}
        />
      )}
    </>
  )
}
