/**
 * The entity drawer's footer. Reading: when it was created and last changed, and by whom, on the
 * line being read, and when the live graph last caught up (DrawerActivity). Editing — typing in a
 * field, or holding changes staged on this entity — where the edit stands (EntityChangeStrip).
 */
import { ArrowUpRight } from 'lucide-react'
import type { EntitySummary } from '@/services/versioningApiService'
import { DrawerFooter } from '../shell/DrawerShell'
import { DrawerActivity } from '../shell/DrawerActivity'
import { EntityChangeStrip, useStagedNodeEdit } from './EntityChangeStrip'

export function EntityFooter({ nodeId, editing, dirty, justStaged, onCancel, summary, summaryLoading, wsId, graphId, inDraft, externalUrl }: {
  nodeId: string
  /** The Edit tab is open, or an edit waits to be staged. */
  editing: boolean
  dirty: boolean
  justStaged: boolean
  onCancel: () => void
  summary?: EntitySummary
  summaryLoading: boolean
  wsId?: string
  graphId?: string | null
  inDraft: boolean
  externalUrl: string | null
}) {
  const staged = useStagedNodeEdit(nodeId)
  if (editing || staged) {
    return (
      <DrawerFooter>
        <EntityChangeStrip nodeId={nodeId} dirty={dirty} justStaged={justStaged} onCancel={onCancel} />
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
