/**
 * OwnLayerActions — what the maker of a Playground semantic layer of their own does with it, in
 * the editor's header: see whether it is theirs alone or shared; share it with the Playground, so
 * others may build on it (read-only), or stop; and once a version is published, move their graphs
 * still on an older version of it to this one.
 */
import { useId, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, Lock, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { layerRefusal } from '@/components/playground/layerRefusal'
import { usePlayground } from '@/hooks/usePlayground'
import { playgroundService } from '@/services/playgroundService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { useAuthStore } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'
import { useOntologyVersions } from '../hooks/useOntologies'
import { useOntologyMutations } from '../hooks/useOntologyMutations'
import type { SemanticLayerAccess } from '../lib/useSemanticLayerAccess'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function OwnLayerActions({ ontology, access, workspaces }: {
  ontology: OntologyDefinitionResponse
  access: SemanticLayerAccess
  workspaces: WorkspaceResponse[]
}) {
  const shareId = useId()
  const { notify } = useAppNotifications()
  const { invalidateAll } = useOntologyMutations()
  const queryClient = useQueryClient()
  const me = useAuthStore(s => s.user?.id)
  const playgroundId = usePlayground().data?.workspaceId
  const { data: versions } = useOntologyVersions(ontology.id)
  const [busy, setBusy] = useState<'share' | 'move' | null>(null)

  const shared = ontology.ownerVisibility === 'workspace'
  // The reader's graphs in the Playground still on an older version of this layer.
  const older = new Set((versions ?? []).filter(v => v.version < ontology.version).map(v => v.id))
  const behind = ontology.isPublished && !ontology.deletedAt
    ? (workspaces.find(w => w.id === playgroundId)?.dataSources ?? [])
      .filter(ds => !!me && ds.createdBy === me && !!ds.ontologyId && older.has(ds.ontologyId))
    : []

  const refresh = () => {
    invalidateAll()
    void queryClient.invalidateQueries({ queryKey: ['playground'] })
  }

  async function share(next: boolean) {
    setBusy('share')
    try {
      await playgroundService.shareLayer(ontology.id, next)
      notify('success', next
        ? 'Shared with the Playground — others can build on it; only you can change it'
        : 'Only you can see it now — graphs already built on it keep working')
    } catch (e) {
      notify('error', `Couldn’t change who can use it: ${layerRefusal(e)}`)
    } finally {
      refresh()
      setBusy(null)
    }
  }

  async function moveGraphs() {
    if (!playgroundId) return
    setBusy('move')
    let moved = 0
    try {
      for (const ds of behind) {
        await workspaceService.updateDataSource(playgroundId, ds.id, { ontologyId: ontology.id })
        moved++
      }
      notify('success', `${plural(moved, 'graph')} moved to v${ontology.version}`)
    } catch (e) {
      notify('error', `${moved ? `${plural(moved, 'graph')} moved; ` : ''}couldn’t move the rest: ${layerRefusal(e)}`)
    } finally {
      await useWorkspacesStore.getState().loadWorkspaces()
      refresh()
      setBusy(null)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span
        title={shared ? 'Shared with the Playground: others can build on it, and only you can change it' : 'Only you can see and change it'}
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1',
          shared
            ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/25'
            : 'bg-violet-500/10 text-violet-700 dark:text-violet-300 ring-violet-500/25',
        )}
      >
        {shared ? <Users className="w-3 h-3" aria-hidden /> : <Lock className="w-3 h-3" aria-hidden />}
        {shared ? 'Shared' : 'Yours'}
      </span>

      {access.canShare && (
        <span className="inline-flex items-center gap-1.5">
          <ToggleSwitch id={shareId} size="sm" checked={shared} disabled={busy !== null} onChange={share} />
          <label htmlFor={shareId} className="cursor-pointer text-xs font-medium text-ink-secondary">
            Share with the Playground
          </label>
          {shared && !ontology.isPublished && (
            <span className="text-[11px] text-ink-muted">· others see it once it’s published</span>
          )}
        </span>
      )}

      {behind.length > 0 && (
        <span className="inline-flex items-center gap-2">
          <span className="text-xs text-ink-muted">
            {plural(behind.length, 'graph')} of yours {behind.length === 1 ? 'uses' : 'use'} an older version.
          </span>
          <Button size="sm" variant="primary" leftIcon={ArrowRightLeft} loading={busy === 'move'} disabled={busy !== null} onClick={moveGraphs}>
            Move my graphs to this version
          </Button>
        </span>
      )}
    </div>
  )
}
