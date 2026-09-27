/**
 * The entity drawer's footer. Reading: when it last changed, and by whom, on the line being read
 * (a draft sees main at its branch point plus its own edits), and when the live graph last caught
 * up. Editing — or holding an edit not staged yet — the stage bar.
 */
import { ArrowUpRight, Loader2, PencilLine, RefreshCcw } from 'lucide-react'
import type { EntitySummary, Watermark } from '@/services/versioningApiService'
import { actorName } from '@/features/versioning/model/branchVocab'
import { DrawerFooter } from '../shell/DrawerShell'
import { FreshnessStat } from '../shell/FreshnessStat'
import { StageBar } from '../shell/StageBar'

export function EntityFooter({ editing, dirty, justStaged, onCancel, onStage, summary, summaryLoading, watermark, externalUrl }: {
  /** The Edit tab is open, or an edit waits to be staged. */
  editing: boolean
  dirty: boolean
  justStaged: boolean
  onCancel: () => void
  onStage: () => void
  summary?: EntitySummary
  summaryLoading: boolean
  watermark?: Watermark
  externalUrl: string | null
}) {
  if (editing) {
    return (
      <DrawerFooter>
        <StageBar dirty={dirty} justStaged={justStaged} onCancel={onCancel} onStage={onStage} />
      </DrawerFooter>
    )
  }

  const updated = summary?.updated
  // "Synced" = when the live read layer last caught up — always at or after the last update, so it
  // never contradicts "Updated". While it is catching up, say so.
  const syncing = watermark?.fresh === false && (watermark.status === 'projecting' || watermark.status === 'rebuilding')
  return (
    <DrawerFooter className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <FreshnessStat
          icon={<PencilLine className="w-4 h-4" />}
          label={updated?.inDraft ? 'Updated · draft' : 'Updated'}
          iso={updated?.at}
          tone="indigo"
          loading={summaryLoading}
          emptyText="No changes yet"
          by={updated ? {
            id: updated.actor && updated.actor !== 'system' ? updated.actor : null,
            name: actorName(updated.actor, summary?.userNames),
          } : undefined}
        />
        <FreshnessStat
          icon={syncing ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <RefreshCcw className="w-4 h-4" />}
          label={syncing ? 'Syncing' : 'Synced'}
          iso={syncing ? undefined : watermark?.lastProjectedAt}
          tone={syncing ? 'amber' : 'emerald'}
          live={!syncing && watermark?.fresh === true}
          overrideValue={syncing ? 'In progress…' : undefined}
        />
      </div>
      {externalUrl && (
        <a href={externalUrl} target="_blank" rel="noopener noreferrer"
          className="w-full flex items-center justify-center gap-1 pt-0.5 text-[11px] text-accent-lineage hover:underline focus-visible:outline-none focus-visible:underline">
          View in DataHub <ArrowUpRight className="w-3 h-3" aria-hidden />
        </a>
      )}
    </DrawerFooter>
  )
}
