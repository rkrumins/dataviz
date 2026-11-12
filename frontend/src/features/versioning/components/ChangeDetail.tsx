/**
 * ChangeDetail — one change in full: what an entity or relationship was before and after, in the
 * change list it belongs to (a draft, or main between two revisions), fetched on its own when shown.
 *
 * - **Added:** the values it was added with.
 * - **Modified:** each field, before → after.
 * - **Deleted:** what it held, with Deletion details.
 *
 * A change list's rows, the review's navigator and the drawers show a change through it, so they
 * read the same entry (`useChangeEntry`), cached per change.
 */
import { SkeletonText } from '@/components/ui/Skeleton'
import type { ChangeListOrigin } from '@/services/versioningApiService'
import { useChangeEntry } from '../hooks/useVersioning'
import type { GraphChange } from '../model/changeModel'
import { EntityDiff } from './EntityDiff'
import { DeletionDetailsButton } from './TombstoneDetails'

export function ChangeDetail({ wsId, graphId, origin, entityId, label }: {
  wsId: string
  graphId: string
  origin: ChangeListOrigin
  entityId: string
  /** Its name, as the caller says it. */
  label: string
}) {
  const q = useChangeEntry(wsId, graphId, origin, entityId)
  if (q.isLoading) return <SkeletonText lines={2} className="py-1" />
  if (q.isError || !q.data) {
    return <p className="text-[11px] text-ink-muted px-2 py-1.5">Couldn't load this change.</p>
  }
  const d = q.data
  const change: GraphChange = {
    entityId: d.entityId,
    kind: d.kind,
    status: d.status === 'unchanged' ? 'modified' : d.status,
    label,
    before: d.before ?? undefined,
    after: d.after ?? undefined,
    origin: 'branchId' in origin
      ? { source: 'branch', branchId: origin.branchId }
      : { source: 'compare', fromSeq: origin.fromSeq, toSeq: origin.toSeq },
  }
  if (change.status !== 'removed') return <EntityDiff change={change} />
  return (
    <>
      <EntityDiff change={change} />
      <DeletionDetailsButton className="mt-1.5"
        target={{ wsId, graphId, entityId: d.entityId, kind: d.kind, origin, label }} />
    </>
  )
}
