/**
 * The entity drawer's footer. Reading: when it was created and last changed, and by whom, on the
 * line being read, and when the live graph last caught up (DrawerActivity). Editing — or holding
 * an edit not staged yet — the stage bar.
 */
import { ArrowUpRight } from 'lucide-react'
import type { EntitySummary } from '@/services/versioningApiService'
import { DrawerFooter } from '../shell/DrawerShell'
import { DrawerActivity } from '../shell/DrawerActivity'
import { StageBar } from '../shell/StageBar'

export function EntityFooter({ editing, dirty, justStaged, onCancel, onStage, summary, summaryLoading, wsId, graphId, inDraft, externalUrl }: {
  /** The Edit tab is open, or an edit waits to be staged. */
  editing: boolean
  dirty: boolean
  justStaged: boolean
  onCancel: () => void
  onStage: () => void
  summary?: EntitySummary
  summaryLoading: boolean
  wsId?: string
  graphId?: string | null
  inDraft: boolean
  externalUrl: string | null
}) {
  if (editing) {
    return (
      <DrawerFooter>
        <StageBar dirty={dirty} justStaged={justStaged} onCancel={onCancel} onStage={onStage} />
      </DrawerFooter>
    )
  }

  return (
    <DrawerFooter className="space-y-2">
      <DrawerActivity summary={summary} loading={summaryLoading} wsId={wsId} graphId={graphId} inDraft={inDraft} />
      {externalUrl && (
        <a href={externalUrl} target="_blank" rel="noopener noreferrer"
          className="w-full flex items-center justify-center gap-1 pt-0.5 text-[11px] text-accent-lineage hover:underline focus-visible:outline-none focus-visible:underline">
          View in DataHub <ArrowUpRight className="w-3 h-3" aria-hidden />
        </a>
      )}
    </DrawerFooter>
  )
}
