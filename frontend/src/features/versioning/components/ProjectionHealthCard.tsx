/**
 * ProjectionHealthCard — where one versioned graph's fast read layer lives, and how it is doing.
 *
 * Reads the watermark (which FalkorDB provider and key the graph projects into, whether the
 * platform minted that key or it is the customer's own graph, the fencing epoch, the poll's
 * backoff and the last liveness reset) and places the key on its node by GRAPH id, so a fork's own
 * key is found rather than its source's. `showActions` adds Check sync and Rebuild for managers;
 * everyone else gets the same card read-only. A customer's graph another writer kept writing to
 * says how much of it history doesn't hold; with `dataSourceId`, a manager brings that in.
 *
 * What readers get while a newer version lands is the read mode in force, where it was chosen and
 * why it differs from the one chosen: the watermark's, from a server that resolves it through the
 * settings (it says why: `readModeWhy`), else the settings' answer for the graph (`reads.mode`).
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
import { formatValue, sameValue } from '@/components/settings/format'
import type { TrailScope } from '@/components/settings/types'
import type { ExternalDrift, Watermark } from '@/services/versioningApiService'
import { settingsError, useSettingsSchema, useSettingsValues } from '@/services/settingsService'
import {
  useBringIntoHistory, useProjectionWatermark, useReconcileProjection, useRebuildProjection,
} from '../hooks/useVersioning'
import { SourceChip } from './SettingSource'
import { UpdateProgress } from './UpdateProgress'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function watermarkText(wm: Watermark): string {
  if (wm.status === 'evicted') return 'Unloaded to free memory'
  if (wm.status === 'rehydrating') return 'Loading into memory'
  if (wm.status === 'waiting_capacity') return 'Waiting for room in memory'
  const at = `#${wm.projected} of #${wm.committed}`
  if (wm.status === 'rebuilding') return `${at} · rebuilding`
  if (wm.status === 'projecting') return `${at} · catching up`
  return at
}

const CLASS_LABEL: Record<string, string> = { always: 'Always', standard: 'Standard', coldline: 'Coldline' }

const CLASS_DETAIL: Record<string, string> = {
  always: 'Kept in memory; never unloaded.',
  standard: 'Unloaded when unread for a while or when memory runs short; loaded again on its next read.',
  coldline: 'Unloaded soon after its last read; loaded only when a request needs the graph store.',
}

const EVICTED_BECAUSE: Record<string, string> = {
  idle_standard: 'unread past its idle time', idle_coldline: 'unread past its idle time',
  pressure: 'to make room', lost: 'its graph store lost it', admin: 'by an administrator',
  load_stalled: 'its load stalled; it loads again on its next read',
}

/** The read mode in force, the one chosen, where it was chosen, and why the two differ. */
interface InForce {
  effective: string
  declared: string | null
  source: TrailScope | 'env' | null
  why: Array<{ text: string }>
}

/**
 * What readers get while a newer version lands: the mode in force. Where it is the mode chosen, where
 * that was chosen; where it isn't, what was chosen, where, and why. The watermark's, when it says
 * why; else the settings' answer for the graph, read once (the watermark is what this card polls).
 */
function ReadModeRow({ wm, wsId, graphId }: { wm: Watermark; wsId: string; graphId: string }) {
  const fromWatermark = Array.isArray(wm.readModeWhy) && Boolean(wm.readMode)
  const schemaQ = useSettingsSchema()
  const valuesQ = useSettingsValues({ scope: 'graph', workspaceId: wsId, graphId }, { enabled: !fromWatermark, staged: () => true })
  const reads = schemaQ.data?.settings.find((s) => s.key === 'reads.mode')
  const resolved = valuesQ.data?.values['reads.mode']
  const r: InForce | null = fromWatermark
    ? { effective: wm.readMode!, declared: wm.readModeDeclared ?? null, source: wm.readModeSource ?? null, why: wm.readModeWhy! }
    : resolved ? { effective: String(resolved.effective), declared: resolved.declared === null ? null : String(resolved.declared),
      source: resolved.source, why: resolved.status === 'in_effect' ? [] : resolved.why } : null
  const error = fromWatermark ? null : valuesQ.error ? settingsError(valuesQ.error) : null
  const say = (id: string) => (reads ? formatValue(reads, id) : id)

  let shown
  if (error?.type === 'follows_root') {
    shown = <span className="text-ink-secondary">The same as the graph it was forked from</span>
  } else if (error) {
    shown = <><span aria-hidden>—</span><span className="sr-only">Not known</span><span className="block text-[11px] text-ink-secondary">Couldn’t be read: {error.message}</span></>
  } else if (!r || (!reads && !schemaQ.error)) {
    // Without the registry's names (it couldn't be read), the mode's own id says it.
    shown = <Skeleton className="h-4 w-48 max-w-full" />
  } else {
    const chosen = r.declared && !sameValue(r.declared, r.effective) ? r.declared : null
    const where = r.source && <SourceChip source={r.source} />
    const promise = reads?.choices.find((c) => c.id === r.effective)?.promise ?? ''
    shown = (
      <>
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {/* The tip is the pointer's; the same words are read out to a screen reader. */}
          <HoverTip label={say(r.effective)} detail={promise}>
            <span className="font-medium">{say(r.effective)}{promise && <span className="sr-only">: {promise}</span>}</span>
          </HoverTip>
          {!chosen && where}
        </span>
        {chosen && (
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
            <span>Chosen: {say(chosen)}</span>{where}
          </span>
        )}
        {r.why[0]?.text && <span className="block text-[11px] text-amber-800 dark:text-amber-400">{r.why[0].text}</span>}
      </>
    )
  }
  return (
    <>
      <dt className="text-ink-secondary">Readers get</dt>
      <dd className="min-w-0 text-ink">{shown}</dd>
    </>
  )
}

/** Whether the graph is in memory, in plain words (residency, doc 17). */
function residencyText(wm: Watermark): string {
  switch (wm.residencyState) {
    case 'evicted':
      return wm.evictedReason && EVICTED_BECAUSE[wm.evictedReason]
        ? `Out of memory · ${EVICTED_BECAUSE[wm.evictedReason]}` : 'Out of memory'
    case 'rehydrating': return 'Loading into memory'
    case 'waiting_capacity': return 'Waiting for room in memory'
    default: return 'In memory'
  }
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
        <ReadModeRow wm={wm} wsId={wsId} graphId={graphId} />
        {wm.residency && (
          <>
            <dt className="text-ink-muted">Residency</dt>
            <dd className="text-ink min-w-0">
              <HoverTip label={CLASS_LABEL[wm.residency] ?? wm.residency} detail={CLASS_DETAIL[wm.residency] ?? ''}>
                <span className="font-medium">{CLASS_LABEL[wm.residency] ?? wm.residency}</span>
              </HoverTip>
              <span className="text-ink-muted"> · {residencyText(wm)}</span>
            </dd>
          </>
        )}
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
        {wm.quarantine && wm.quarantine.count > 0 && (
          <>
            <dt className="text-ink-muted">Held back</dt>
            <dd className="min-w-0 text-amber-700 dark:text-amber-400">
              {plural(wm.quarantine.count, 'change', 'changes')} couldn't be written to the fast read
              layer, even on {wm.quarantine.count === 1 ? 'its' : 'their'} own. Everything else is
              published; {wm.quarantine.count === 1 ? 'it is' : 'they are'} retried every few minutes.
              <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                {wm.quarantine.entities.slice(0, 5).map((e) => (
                  <li key={`${e.statement}:${e.entityKey}`} className="break-all">
                    {e.entityKey}{e.error ? ` · ${e.error}` : ''}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>

      <UpdateProgress progress={wm.progress} className="mt-3 border-t border-glass-border pt-3" />

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
          // Anything else is the graph's to fix (a type it spells two ways), in its own words.
          ok: r.skippedReason === 'projection in flight' || r.skippedReason === 'no projection target',
          text: r.skippedReason === 'projection in flight'
            ? 'A refresh is in progress — check again in a moment.'
            : r.skippedReason === 'no projection target'
              ? 'This graph has no fast read layer yet.'
              : r.skippedReason,
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
        notify('info', res.alreadyRunning ? 'A rebuild is already in progress.'
          : res.beside ? 'Rebuild started in a new copy. Everyone keeps the current version until it is checked and switched to.'
            : 'Rebuild started.')
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
