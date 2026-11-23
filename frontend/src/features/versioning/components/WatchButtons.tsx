/**
 * Watch toggles: the graph, from the view's page header, and one entity, from its panel. Watching
 * means your Inbox tells you when a version is published that changes what you watch — one
 * notification a publish, never for your own.
 *
 * Toggle buttons: the accessible name stays "Watch this graph" / "Watch this entity" and
 * `aria-pressed` carries the state; the visible word says it ("Watch" / "Watching"). Both share
 * one query per graph (`useGraphWatch`), so a change in one shows in the other.
 */
import { Eye, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { useAppNotifications } from '@/components/ui/notifications'
import { useFeature } from '@/store/features'
import { useGraphWatch, useSetWatch } from '../hooks/useDigest'
import { useResolveGraph } from '../hooks/useVersioning'

function useToggle(wsId: string, graphId: string | null, urn?: string) {
  const q = useGraphWatch(wsId, graphId)
  const set = useSetWatch(wsId, graphId ?? '')
  const { notify } = useAppNotifications()
  const on = urn ? !!q.data?.entities.some((e) => e.urn === urn) : !!q.data?.graph
  const toggle = () => set.mutate({ on: !on, urn }, {
    onError: (e) => notify('error', `Couldn’t change what you watch: ${(e as Error).message}`),
  })
  return { on, ready: q.isSuccess, failed: q.isError, busy: set.isPending, toggle }
}

/** Held while what you watch can't be read: a guess would flip the wrong way. */
const UNREAD = { label: 'What you watch couldn’t be read', detail: 'Reload the page to try again.' }

/** "Watch" in the view's page header, for the graph behind the view. Nothing until the view's
 *  data source has a versioned graph with a first version (the same rule as Reviews). */
export function GraphWatchButton({ workspaceId, dataSourceId, viewId, className }: {
  workspaceId: string
  dataSourceId: string | null
  viewId: string
  className?: string
}) {
  const versioningEnabled = useFeature('versioningEnabled')
  // The same query key the bar and the canvas use: a shared lookup, not another one.
  const resolve = useResolveGraph(workspaceId, versioningEnabled ? dataSourceId : null, viewId)
  const graphId = resolve.data?.graphId ?? null
  const seeded = resolve.data?.kind === 'blank' || (resolve.data?.mainHeadCommitSeq ?? 0) > 1
  const watch = useToggle(workspaceId, versioningEnabled && seeded ? graphId : null)
  if (!versioningEnabled || !graphId || !seeded) return null
  return (
    <HoverTip
      className="inline-flex"
      label={watch.failed ? UNREAD.label : watch.on ? 'You’re watching this graph' : 'Watch this graph'}
      detail={watch.failed ? UNREAD.detail : watch.on
        ? 'Your Inbox tells you when a new version is published. Click to stop.'
        : 'Get told in your Inbox when a new version is published.'}
    >
      <button
        type="button"
        onClick={watch.toggle}
        disabled={!watch.ready || watch.busy}
        aria-pressed={watch.on}
        aria-label="Watch this graph"
        className={cn(className, watch.on && 'text-accent-lineage')}
      >
        {watch.busy
          ? <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          : <Eye className="w-3.5 h-3.5" aria-hidden />}
        <span className="hidden lg:inline">{watch.on ? 'Watching' : 'Watch'}</span>
      </button>
    </HoverTip>
  )
}

/** "Watch" among an entity's quick actions: tells you when a publish changes it. */
export function EntityWatchButton({ wsId, graphId, urn, name }: {
  wsId: string
  graphId: string
  urn: string
  name: string
}) {
  const watch = useToggle(wsId, graphId, urn)
  return (
    <HoverTip
      className="inline-flex"
      label={watch.failed ? UNREAD.label : watch.on ? `You’re watching ${name}` : `Watch ${name}`}
      detail={watch.failed ? UNREAD.detail : watch.on
        ? 'Your Inbox tells you when a publish changes it. Click to stop.'
        : 'Get told in your Inbox when a publish changes it.'}
    >
      <Button
        size="sm"
        variant={watch.on ? 'secondary' : 'subtle'}
        leftIcon={Eye}
        loading={watch.busy}
        disabled={!watch.ready}
        onClick={watch.toggle}
        aria-pressed={watch.on}
        aria-label="Watch this entity"
        className={cn(watch.on && 'text-accent-lineage border-accent-lineage/30')}
      >
        {watch.on ? 'Watching' : 'Watch'}
      </Button>
    </HoverTip>
  )
}
