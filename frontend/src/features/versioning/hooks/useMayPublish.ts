import { usePermission } from '@/store/auth'
import { useBranches } from './useVersioning'

/** Whether the reader may advance the graph's main — publish, restore, revert, pause editing: the
 *  server's word on main (`BranchAccess.canPublish`: the publish permission, or in the Playground
 *  having made the graph), else the publish permission while the list loads or on servers that
 *  predate it. */
export function useMayPublish(wsId?: string, graphId?: string | null): boolean {
  const holdsPublish = usePermission('workspace:datasource:publish', wsId)
  const main = useBranches(wsId, graphId).data?.find((b) => b.kind === 'main')
  return main?.access?.canPublish ?? holdsPublish
}
