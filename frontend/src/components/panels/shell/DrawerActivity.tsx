/**
 * DrawerActivity — the drawer footer's three facts, the same in both drawers: when the entity was
 * created and last changed, and by whom, on the line being read (a draft sees main at its branch
 * point plus its own edits); and when the live graph last caught up with saved changes.
 *
 * Everything the summary knows besides lives in the cards' tooltips — revision counts, and who a
 * published change is credited to. A change made on the published graph after the draft began is
 * said above the cards: the draft still shows the entity as it was.
 */
import { AlertTriangle, Loader2, PencilLine, RefreshCcw, Sparkles } from 'lucide-react'
import type { EntityEvent, EntitySummary } from '@/services/versioningApiService'
import { useProjectionWatermark } from '@/features/versioning/hooks/useVersioning'
import { actorName } from '@/features/versioning/model/branchVocab'
import { FreshnessStat } from './FreshnessStat'

const PUBLISHED_CREDIT = 'A published change is credited to whoever published it.'

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
  const by = (e?: EntityEvent | null) => e
    ? { id: e.actor && e.actor !== 'system' ? e.actor : null, name: actorName(e.actor ?? undefined, summary?.userNames) }
    : undefined
  const revisions = summary && (
    `${summary.revisions.published.toLocaleString()} published`
    + (inDraft ? ` · ${summary.revisions.draft.toLocaleString()} in this draft` : '')
  )
  const credit = (e?: EntityEvent | null) => (e?.inDraft ? 'In this draft — not published yet.' : PUBLISHED_CREDIT)

  return (
    <div className="space-y-2">
      {summary?.changedOnMainSinceBranch && (
        <p role="status" className="flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" aria-hidden />
          Changed on the published graph since this draft began — the draft still shows it as it was.
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        <FreshnessStat
          icon={<Sparkles />}
          label="Created"
          iso={summary?.created?.at}
          tone="sky"
          loading={loading}
          emptyText="—"
          note="Not recorded"
          by={by(summary?.created)}
          tag={summary?.created?.inDraft ? 'draft' : undefined}
          tip={credit(summary?.created)}
        />
        <FreshnessStat
          icon={<PencilLine />}
          label="Updated"
          iso={summary?.updated?.at}
          tone="indigo"
          loading={loading}
          emptyText="—"
          note="No changes yet"
          by={by(summary?.updated)}
          tag={summary?.updated?.inDraft ? 'draft' : undefined}
          tip={<>{revisions && <span className="block">{revisions}</span>}{credit(summary?.updated)}</>}
        />
        <FreshnessStat
          icon={syncing ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RefreshCcw />}
          label={syncing ? 'Syncing' : 'Synced'}
          iso={syncing ? undefined : watermark?.lastProjectedAt}
          tone={syncing ? 'amber' : 'emerald'}
          live={!syncing && watermark?.fresh === true}
          overrideValue={syncing ? 'Catching up…' : undefined}
          note={syncing ? 'Live graph' : watermark?.fresh === false ? 'Live graph behind' : 'Live graph'}
          tip="When the live graph last caught up with saved changes."
        />
      </div>
    </div>
  )
}
