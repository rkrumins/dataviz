/**
 * PropertyOpHost — the one place the bulk property dialog opens, for every surface that asks
 * (`usePropertyJobsStore.requestOp`): a catalog row, the layer menu, a container, a search's
 * matches, a selection. Mounted once by the canvas, which says where a change can be written —
 * the draft open here — or why it can't.
 */
import { useEffect } from 'react'
import { useAppNotifications } from '@/components/ui/notifications'
import { useCanvasStore } from '@/store/canvas'
import { usePropertyJobsStore } from '@/store/propertyJobsStore'
import { PropertyOpDialog, type GraphWrite } from './op/PropertyOpDialog'
import type { LayerOption } from './op/WhereStep'

export function PropertyOpHost({ viewId, graphWrite, blocked, knownEntityTypes, layers }: {
  viewId: string
  /** The draft a change is written to; null where none can be. */
  graphWrite: GraphWrite | null
  /** Why a change can't be written here, said when one is asked for anyway. */
  blocked?: string | null
  knownEntityTypes: string[]
  layers: readonly LayerOption[]
}) {
  const request = usePropertyJobsStore((s) => s.request)
  const seq = usePropertyJobsStore((s) => s.requestSeq)
  const selectionIds = useCanvasStore((s) => s.selectedNodeIds)
  const { notify } = useAppNotifications()

  useEffect(() => {
    if (!request || graphWrite) return
    usePropertyJobsStore.getState().consumeRequest()
    notify('info', blocked ?? 'Open a draft to change properties.')
  }, [request, graphWrite, blocked, notify])

  if (!request || !graphWrite) return null
  return (
    <PropertyOpDialog
      key={seq}
      viewId={viewId}
      graphWrite={graphWrite}
      seed={request}
      knownEntityTypes={knownEntityTypes}
      layers={layers}
      selectionIds={selectionIds.filter((id) => !id.startsWith('logical:'))}
      onClose={() => usePropertyJobsStore.getState().consumeRequest()}
    />
  )
}
