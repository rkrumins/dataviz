/**
 * ServiceTile — one infrastructure component: status (icon + word, never
 * color alone), probe latency, a per-service WORK-signal line (consumers /
 * hit rate / connections — not just liveness), a latency sparkline, and a
 * technical disclosure for degraded reasons + raw error.
 */
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ServiceEntry } from '@/services/systemStatusService'
import { STATUS_META, formatAgeMs, formatBytes, num, obj, str } from './meta'
import { Sparkline } from '@/components/ui/Sparkline'

/** The one-line work signal per service — what the component is DOING. */
function workSignal(svc: ServiceEntry): string[] {
    const d = svc.detail
    const parts: string[] = []
    switch (svc.key) {
        case 'vizService': {
            const loop = obj(d, 'eventLoop')
            const disk = obj(d, 'disk')
            if (loop && typeof loop.p99Ms === 'number') parts.push(`loop p99 ${loop.p99Ms}ms`)
            if (disk && typeof disk.usedPct === 'number') parts.push(`disk ${disk.usedPct}%`)
            const worker = obj(d, 'projectionWorker')
            if (worker?.mode === 'inprocess') parts.push(worker.alive ? 'projection worker live' : 'projection worker dead')
            break
        }
        case 'managementDb':
        case 'graphverDb': {
            const size = formatBytes(num(d, svc.key === 'graphverDb' ? 'schemaSizeBytes' : 'dbSizeBytes'))
            if (size) parts.push(size)
            const conns = obj(d, 'connections')
            if (conns && typeof conns.total === 'number') {
                parts.push(`${conns.total}/${typeof conns.max === 'number' ? conns.max : '?'} conns`)
            }
            const xact = num(d, 'longestXactAgeS')
            if (xact != null && xact > 5) parts.push(`xact ${Math.round(xact)}s`)
            break
        }
        case 'busRedis': {
            const mem = str(d, 'usedMemoryHuman')
            if (mem) parts.push(mem)
            const clients = num(d, 'connectedClients')
            if (clients != null) parts.push(`${clients} clients`)
            const ops = num(d, 'opsPerSec')
            if (ops != null) parts.push(`${ops} ops/s`)
            break
        }
        case 'cacheRedis': {
            const hit = num(d, 'hitRate')
            if (hit != null) parts.push(`${hit}% hit rate`)
            const keys = num(d, 'keys')
            if (keys != null) parts.push(`${keys} keys`)
            const mem = str(d, 'usedMemoryHuman')
            if (mem) parts.push(mem)
            break
        }
        case 'falkordb': {
            const graphs = num(d, 'graphCount')
            if (graphs != null) parts.push(`${graphs} graphs`)
            const mem = str(d, 'usedMemoryHuman')
            if (mem) parts.push(mem)
            // Topology facts the probe already computes: the resolved sentinel
            // master and the cluster shard rollup.
            const master = str(d, 'master')
            if (master) parts.push(`master ${master}`)
            const shardsUp = num(d, 'shardsUp')
            const shardsTotal = num(d, 'shardsTotal')
            if (shardsUp != null && shardsTotal != null) parts.push(`${shardsUp}/${shardsTotal} shards`)
            break
        }
        case 'aggregationWorker': {
            const consumers = num(d, 'consumers')
            if (consumers != null) parts.push(`${consumers} consumer${consumers === 1 ? '' : 's'}`)
            const lag = num(d, 'groupLag')
            if (lag != null) parts.push(`lag ${lag}`)
            const pendingAge = formatAgeMs(num(d, 'oldestPendingAgeMs'))
            if (pendingAge) parts.push(`oldest pending ${pendingAge}`)
            const worker = obj(d, 'worker')
            if (worker && typeof worker.activeJobs === 'number') parts.push(`${worker.activeJobs} active`)
            break
        }
        case 'statsService': {
            const active = num(d, 'activeJobs')
            if (active != null) parts.push(`${active} active job${active === 1 ? '' : 's'}`)
            const consumers = num(d, 'consumers')
            if (consumers != null) parts.push(`${consumers} stream consumers`)
            const uptime = num(d, 'uptime')
            if (uptime != null) parts.push(`up ${formatAgeMs(uptime * 1000)}`)
            break
        }
        default:
            break
    }
    return parts
}

/** A small qualifier badge (topology fact, not a status). */
function qualifier(svc: ServiceEntry): string | null {
    if (svc.key === 'graphverDb' && svc.detail.colocated === true) return 'colocated'
    if (svc.key === 'aggregationControlplane' && svc.detail.mode === 'inprocess') return 'in-process dispatch'
    if (svc.key === 'aggregationControlplane' && svc.detail.mode === 'proxy') return 'proxy'
    if (svc.key === 'falkordb' && (svc.detail.mode === 'sentinel' || svc.detail.mode === 'cluster')) {
        return String(svc.detail.mode)
    }
    if (svc.key === 'cacheRedis' && svc.detail.scope === 'global') return 'global endpoint'
    return null
}

interface Props {
    svc: ServiceEntry
    history?: number[]
}

export function ServiceTile({ svc, history }: Props) {
    const [open, setOpen] = useState(false)
    const meta = STATUS_META[svc.status] ?? STATUS_META.unknown
    const StatusIcon = meta.icon
    const reasons = Array.isArray(svc.detail.reasons)
        ? (svc.detail.reasons as unknown[]).filter((r): r is string => typeof r === 'string')
        : []
    const hasDisclosure = reasons.length > 0 || !!svc.error
    const signal = workSignal(svc)
    const badge = qualifier(svc)

    return (
        <div className={cn(
            'relative overflow-hidden border rounded-xl p-4 bg-canvas-elevated transition-all duration-200 hover:shadow-lg',
            svc.status === 'down' ? 'border-red-500/30'
                : svc.status === 'degraded' ? 'border-amber-500/30'
                    : 'border-glass-border',
        )}>
            {svc.status !== 'healthy' && svc.status !== 'unknown' && (
                <div className={cn(
                    'absolute inset-0 bg-gradient-to-br to-transparent pointer-events-none',
                    svc.status === 'down' ? 'from-red-500/10' : 'from-amber-500/10',
                )} />
            )}
            <div className="relative">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <div className="flex items-start gap-2">
                            <span className={cn('w-2 h-2 rounded-full shrink-0 mt-1.5', meta.dot,
                                svc.status === 'down' && 'animate-pulse')} />
                            <span className="text-sm font-semibold text-ink leading-tight">{svc.label}</span>
                        </div>
                        <div className={cn('mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide', meta.chip)}>
                            <StatusIcon className="w-3 h-3" />
                            {meta.label}
                        </div>
                        {badge && (
                            <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded-full border border-glass-border bg-black/5 dark:bg-white/5 text-[10px] text-ink-muted">
                                {badge}
                            </span>
                        )}
                    </div>
                    {svc.latencyMs != null && (
                        <span className="text-[11px] text-ink-muted tabular-nums shrink-0" title="Probe latency">
                            {svc.latencyMs < 1 ? '<1' : Math.round(svc.latencyMs)}ms
                        </span>
                    )}
                </div>

                <div className="mt-3 flex items-end justify-between gap-2 min-h-[24px]">
                    <p className="text-xs text-ink-muted leading-snug min-w-0">
                        {signal.length > 0 ? signal.join(' · ') : ' '}
                    </p>
                    {history && <Sparkline points={history} className="shrink-0" />}
                </div>

                {hasDisclosure && (
                    <div className="mt-2">
                        <button
                            onClick={() => setOpen(o => !o)}
                            className="flex items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink-secondary transition-colors"
                        >
                            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                            Details
                        </button>
                        {open && (
                            <div className="mt-1.5 space-y-1">
                                {reasons.map((r) => (
                                    <p key={r} className="text-[11px] text-amber-600 dark:text-amber-400">{r}</p>
                                ))}
                                {svc.error && (
                                    <p className="text-[11px] font-mono text-ink-muted break-all">{svc.error}</p>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
