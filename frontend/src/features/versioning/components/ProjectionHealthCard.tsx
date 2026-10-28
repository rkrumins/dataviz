/**
 * ProjectionHealthCard — where one versioned graph's fast read layer lives, and how it is doing.
 *
 * Reads the watermark (which FalkorDB provider and key the graph projects into, whether the
 * platform minted that key or it is the customer's own graph, the fencing epoch, the poll's
 * backoff and the last liveness reset) and places the key on its node by GRAPH id, so a fork's own
 * key is found rather than its source's. `showActions` adds Check sync and Rebuild for managers;
 * everyone else gets the same card read-only. A customer's graph another writer kept writing to
 * says how much of it history doesn't hold; with `dataSourceId`, a manager brings that in.
 */
import { useState } from 'react'
import { Database, History, RefreshCw, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import { PlacementRow } from '@/components/admin/AdminGraphStore/GraphStorePlacementCard'
import { useGraphPlacementByGraph } from '@/components/admin/shared/useGraphStoreTopology'
import type { ExternalDrift, Watermark } from '@/services/versioningApiService'
import {
  useBringIntoHistory, useProjectionWatermark, useReconcileProjection, useRebuildProjection,
} from '../hooks/useVersioning'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function watermarkText(wm: Watermark): string {
  if (wm.status === 'evicted') return 'Unloaded to free memory'
  const at = `#${wm.projected} of #${wm.committed}`
  if (wm.status === 'rebuilding') return `${at} · rebuilding`
  if (wm.status === 'projecting') return `${at} · catching up`
  return at
}

function notInHistory(d: ExternalDrift): string {
  const counted = [
    d.nodes ? plural(d.nodes, 'item', 'items') : '',
    d.edges ? plural(d.edges, 'connection', 'connections') : '',
  ].filter(Boolean).join(' and ')
  if (d.via !== 'notification') return counted || 'Changes'
  return counted ? `${counted}, and changes a writer reported` : 'Changes a writer reported'
}

export function ProjectionHealthCard({ wsId, graphId, showActions = false, dataSourceId, className }: {
  wsId: string
  graphId: string
  /** Check sync and Rebuild — for viewers who may manage the data source. */
  showActions?: boolean
  /** The graph's data source, for Bring into history — pass it only to viewers who may also
   *  publish, since what comes in is published. */
  dataSourceId?: string
  className?: string
}) {
  const wmQ = useProjectionWatermark(wsId, graphId)
  const wm = wmQ.data
  const placementQ = useGraphPlacementByGraph(wm?.projectionKey ? graphId : null)

  const shell = cn('rounded-xl border border-glass-border bg-canvas-elevated/40 p-4', className)

  if (!wm) {
    if (wmQ.isError) {
      return (
        <section className={shell}>
          <p className="text-[12px] text-red-600 dark:text-red-400">Could not read where this graph lives.</p>
          <Button size="sm" variant="secondary" className="mt-2" leftIcon={RefreshCw} onClick={() => wmQ.refetch()}>
            Retry
          </Button>
        </section>
      )
    }
    return (
      <section className={shell} aria-busy="true" aria-label="Loading the fast read layer">
        <Skeleton className="h-4 w-40" />
        <SkeletonText lines={3} className="mt-3" />
      </section>
    )
  }

  if (!wm.projectionKey) {
    return (
      <section className={shell}>
        <EmptyState
          compact
          icon={Database}
          title="Not in the graph store yet"
          description="This graph has no fast read layer yet. Reads come from the source of truth until it is first projected."
        />
      </section>
    )
  }

  const placements = placementQ.data
  return (
    <section className={shell}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Database className="w-4 h-4 text-ink-muted shrink-0" aria-hidden />
          <h3 className="text-sm font-semibold text-ink font-display tracking-tight">Fast read layer</h3>
        </div>
        <HoverTip
          label={wm.owned ? 'Platform copy' : 'Customer graph'}
          detail={wm.owned
            ? 'A graph key the platform created for this versioned graph and manages itself.'
            : 'Your own graph in the store, which version control writes into.'}
        >
          <Badge tone={wm.owned ? 'accent' : 'neutral'} size="md">
            {wm.owned ? 'Platform copy' : 'Customer graph'}
          </Badge>
        </HoverTip>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        <dt className="text-ink-muted">Provider</dt>
        <dd className="text-ink min-w-0 truncate">{wm.providerName ?? wm.providerId ?? 'Default graph store'}</dd>
        <dt className="text-ink-muted">Key</dt>
        <dd className="font-mono text-[11px] text-ink-secondary break-all">{wm.projectionKey}</dd>
        <dt className="text-ink-muted">Watermark</dt>
        <dd className="text-ink tabular-nums">{watermarkText(wm)}</dd>
        <dt className="text-ink-muted">Epoch</dt>
        <dd className="text-ink tabular-nums">{wm.epoch ?? 0}</dd>
        <dt className="text-ink-muted">Backoff</dt>
        <dd className={cn('min-w-0', (wm.failedAttempts ?? 0) > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-ink')}>
          {(wm.failedAttempts ?? 0) > 0 ? (
            <>
              {plural(wm.failedAttempts!, 'failed attempt', 'failed attempts')} in a row
              {wm.nextRetryAt && <> · next try <DateTime at={wm.nextRetryAt} variant="calendar" /></>}
            </>
          ) : 'None'}
        </dd>
        <dt className="text-ink-muted">Liveness</dt>
        <dd className={cn('min-w-0 break-words', wm.livenessError ? 'text-red-600 dark:text-red-400 font-mono text-[11px]' : 'text-ink')}>
          {wm.livenessError ?? 'No problems recorded'}
        </dd>
        {wm.externalDrift && (
          <>
            <dt className="text-ink-muted">Not in history</dt>
            <dd className="min-w-0 text-amber-700 dark:text-amber-400">
              {notInHistory(wm.externalDrift)}
              {wm.externalDrift.at && <> · as of <DateTime at={wm.externalDrift.at} variant="calendar" /></>}
            </dd>
          </>
        )}
      </dl>

      <div className="mt-3">
        {placementQ.isLoading && !placements ? (
          <Skeleton className="h-14 w-full" />
        ) : !placements ? (
          <p className="text-[11px] text-ink-muted">Node and shard details are unavailable.</p>
        ) : !placements.reachable ? (
          <p className="text-[11px] text-red-600 dark:text-red-400">
            This graph store could not be reached: {placements.error ?? 'no node answered'}.
          </p>
        ) : placements.placements.length === 0 ? (
          <p className="text-[11px] text-ink-muted">Not on any node yet.</p>
        ) : (
          <div className="space-y-2">
            {placements.placements.map((p) => (
              <PlacementRow key={p.graphKey} placement={p} instanceId={placements.instanceId} label="versioned graph" />
            ))}
          </div>
        )}
      </div>

      {showActions && (
        <ProjectionActions wsId={wsId} graphId={graphId} owned={wm.owned !== false}
          bringIn={wm.externalDrift ? dataSourceId : undefined} />
      )}
    </section>
  )
}

/** Check sync (a shallow reconcile, its verdict in one line), Rebuild behind an inline confirm, and
 *  Bring into history behind another when the graph holds what history doesn't (`bringIn`: its data
 *  source). The Data health tab has the full drift breakdown and follows a rebuild to its end. */
function ProjectionActions({ wsId, graphId, owned, bringIn }: {
  wsId: string; graphId: string; owned: boolean; bringIn?: string
}) {
  const { notify } = useAppNotifications()
  const reconcile = useReconcileProjection(wsId, graphId)
  const rebuild = useRebuildProjection(wsId, graphId)
  const bring = useBringIntoHistory(wsId, graphId)
  const [verdict, setVerdict] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirming, setConfirming] = useState<'rebuild' | 'bring' | null>(null)

  const check = () => {
    reconcile.mutate({ deep: false }, {
      onSuccess: (r) => setVerdict(
        r.skippedReason ? {
          ok: true,
          text: r.skippedReason === 'projection in flight'
            ? 'A refresh is in progress — check again in a moment.'
            : 'This graph has no fast read layer yet.',
        }
        : r.inSync ? { ok: true, text: `In sync — ${plural(r.pgNodes, 'item', 'items')} and ${plural(r.pgEdges, 'connection', 'connections')} checked.` }
        : { ok: false, text: 'Out of date — rebuild to repair it.' }),
      onError: (e) => notify('error', (e as Error).message),
    })
  }

  const doRebuild = () => {
    setConfirming(null)
    rebuild.mutate(undefined, {
      onSuccess: (res) => {
        setVerdict(null)
        notify('info', res.alreadyRunning ? 'A rebuild is already in progress.' : 'Rebuild started.')
      },
      onError: (e) => notify('error', (e as Error).message),
    })
  }

  const doBring = (dataSourceId: string) => {
    setConfirming(null)
    bring.mutate(dataSourceId, {
      onSuccess: (res) => {
        setVerdict(null)
        notify('success', res.applied
          ? `Brought ${plural(res.applied, 'change', 'changes')} into history.`
          : 'Nothing new to bring in.')
      },
      onError: (e) => notify('error', (e as Error).message),
    })
  }

  return (
    <div className="mt-3 border-t border-glass-border pt-3">
      {confirming === 'rebuild' ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
          <span className="min-w-0 flex-1">
            {owned ? (
              <>Rebuild the fast read layer from the source of truth? <span className="font-semibold text-ink">No data is lost.</span></>
            ) : (
              <>Write what version history holds back into your graph? Items&apos; fields go back to their values in history; <span className="font-semibold text-ink">nothing history doesn&apos;t hold is removed.</span></>
            )}
          </span>
          <Button size="sm" variant="primary" leftIcon={RotateCcw} onClick={doRebuild}>Rebuild now</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
        </div>
      ) : confirming === 'bring' && bringIn ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
          <span className="min-w-0 flex-1">
            Bring what was written outside version control into history? It is published as one commit.
          </span>
          <Button size="sm" variant="primary" leftIcon={History} onClick={() => doBring(bringIn)}>Bring in</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" leftIcon={RefreshCw} loading={reconcile.isPending} onClick={check}>
            Check sync
          </Button>
          <Button size="sm" variant="ghost" leftIcon={RotateCcw} loading={rebuild.isPending} onClick={() => setConfirming('rebuild')}>
            Rebuild
          </Button>
          {bringIn && (
            <Button size="sm" variant="secondary" leftIcon={History} loading={bring.isPending} onClick={() => setConfirming('bring')}>
              Bring into history
            </Button>
          )}
        </div>
      )}
      {verdict && (
        <p className={cn('mt-2 text-[12px]', verdict.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400')}>
          {verdict.text}
        </p>
      )}
    </div>
  )
}
