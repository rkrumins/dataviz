/**
 * DrawerActivity — the drawer footer's two facts, the same in both drawers: when the entity last
 * changed, and by whom, on the line being read (a draft sees main at its branch point plus its own
 * edits); and when the live graph last caught up with saved changes.
 *
 * The rest of what the summary knows is in the Updated card's tooltip: when it was created and by
 * whom, its revision counts, and who a published change is credited to. A change made on the
 * published graph after the draft began is said above the cards: the draft still shows the entity
 * as it was.
 */
import { AlertTriangle, Loader2, PencilLine, RefreshCcw } from 'lucide-react'
import type { EntityEvent, EntitySummary } from '@/services/versioningApiService'
import { useProjectionWatermark } from '@/features/versioning/hooks/useVersioning'
import { actorName } from '@/features/versioning/model/branchVocab'
import { timeAgo } from '@/lib/timeAgo'
import { FreshnessStat } from './FreshnessStat'

export function DrawerActivity({ summary, loading, wsId, graphId, inDraft }: {
  summary?: EntitySummary
  loading: boolean
  wsId?: string
  graphId?: string | null
  /** A draft is open — its own revisions are counted apart. */
  inDraft: boolean
}) {
  const watermark = useProjectionWatermark(wsId, graphId).data
  // "Synced" = when the live read layer last caught up — always at or after the last update, so it
  // never contradicts "Updated". While it is catching up, say so.
  const syncing = watermark?.fresh === false && (watermark.status === 'projecting' || watermark.status === 'rebuilding')
  const name = (e: EntityEvent) => actorName(e.actor ?? undefined, summary?.userNames)
  const updated = summary?.updated
  const created = summary?.created

  return (
    <div className="space-y-2">
      {summary?.changedOnMainSinceBranch && (
        <p role="status" className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden />
          Changed on the published graph since this draft began — the draft still shows it as it was.
        </p>
      )}
      <div className="grid grid-cols-[3fr_2fr] gap-2">
        <FreshnessStat
          icon={<PencilLine className="w-4 h-4" />}
          label={updated?.inDraft ? 'Updated · draft' : 'Updated'}
          iso={updated?.at}
          tone="indigo"
          loading={loading}
          emptyText="No changes yet"
          by={updated ? { id: updated.actor && updated.actor !== 'system' ? updated.actor : null, name: name(updated) } : undefined}
          tip={summary && (
            <>
              {created && <span className="block">Created {timeAgo(created.at)} by {name(created)}{created.inDraft ? ', in this draft' : ''}</span>}
              <span className="block">
                {summary.revisions.published.toLocaleString()} published
                {inDraft && <> · {summary.revisions.draft.toLocaleString()} in this draft</>}
              </span>
              {updated?.inDraft ? 'Not published yet.' : 'A published change is credited to whoever published it.'}
            </>
          )}
        />
        <FreshnessStat
          icon={syncing ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <RefreshCcw className="w-4 h-4" />}
          label={syncing ? 'Syncing' : 'Synced'}
          iso={syncing ? undefined : watermark?.lastProjectedAt}
          tone={syncing ? 'amber' : 'emerald'}
          live={!syncing && watermark?.fresh === true}
          overrideValue={syncing ? 'In progress…' : undefined}
          tip="When the live graph last caught up with saved changes."
        />
      </div>
    </div>
  )
}
