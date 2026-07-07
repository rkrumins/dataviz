/**
 * diagnostics — turns a raw infrastructure snapshot into a ranked list of
 * plain-language findings, each with a *symptom*, hypotheses for *why it's
 * happening*, and *how to resolve it* (including copy-able commands where a
 * safe one exists).
 *
 * This is the interpretation layer: "3.1k pending" becomes "3,059 messages
 * stranded by a worker that died 13h ago — reclaim them like this." The
 * rules encode operational knowledge of this specific stack (orphaned Redis
 * PEL, PEL-safe trim, disk-fill corruption, blank-workspace poll failures).
 */
import type {
    StreamDepth, SystemStatusSnapshot,
} from '@/services/systemStatusService'
import { formatAgeMs } from './meta'

export type Severity = 'critical' | 'warning' | 'info'

export interface DiagCommand { label: string; cmd: string }
export interface DiagEvidence { label: string; value: string }

export interface Insight {
    id: string
    severity: Severity
    category: string
    title: string
    symptom: string
    why: string[]
    resolution: string[]
    commands?: DiagCommand[]
    evidence?: DiagEvidence[]
}

const SEV_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

const DEAD_IDLE_MS = 5 * 60 * 1000

function liveAndDead(depth: StreamDepth) {
    const detail = depth.consumerDetail ?? []
    const dead = detail
        .filter(c => (c.idleMs ?? 0) > DEAD_IDLE_MS && c.pending > 0)
        .sort((a, b) => b.pending - a.pending)
    const live = detail
        .filter(c => c.idleMs != null && c.idleMs <= DEAD_IDLE_MS)
        .sort((a, b) => (a.idleMs ?? 0) - (b.idleMs ?? 0))
    return { dead, live: live[0] ?? null }
}

export function buildDiagnostics(snap: SystemStatusSnapshot): Insight[] {
    const out: Insight[] = []

    // ── Graph data providers unreachable (any type — generic) ──
    for (const p of snap.graphProviders ?? []) {
        if (p.status !== 'down') continue
        out.push({
            id: `provider:${p.id}`,
            severity: 'warning',
            category: 'Graph provider',
            title: `${p.name} (${p.type}) is unreachable`,
            symptom: `The ${p.type} provider "${p.name}" failed its last reachability check${p.error ? ` (${p.error})` : ''}. Graphs and features that read from it will error or fall back.`,
            why: [
                p.error === 'tcp_refused'
                    ? 'Nothing is listening on the provider’s host:port — the backend process is stopped, crashed, or not started (a local Neo4j/FalkorDB that isn’t running is the usual cause).'
                    : p.error === 'dns_unresolvable'
                        ? 'The provider’s hostname doesn’t resolve — a wrong host in the connection config, or a service name that only exists inside another network.'
                        : p.error === 'connect_timeout'
                            ? 'The host is reachable but the port never completed a handshake — a firewall/security group, TLS mismatch, or an overloaded instance.'
                            : 'The reachability probe (or the circuit breaker from real traffic) marked it unavailable — see the reason above.',
                'This status comes from the shared provider warmup loop + circuit breaker, so it reflects what the app actually experiences — not a separate check.',
            ],
            resolution: [
                `Confirm the ${p.type} instance is running and reachable from the backend; run Providers → ${p.name} → Test connection for a live probe.`,
                'If the provider is intentionally offline, deactivate it so it stops being probed and flagged.',
            ],
            evidence: [
                { label: 'Type', value: p.type },
                ...(p.error ? [{ label: 'Reason', value: p.error }] : []),
            ],
        })
    }

    // ── Redis Streams: orphaned pending (dead consumer holding PEL) ──
    if (snap.streams) {
        for (const depth of snap.streams.streams) {
            const name = depth.name
            if (!depth.orphanedPending || depth.orphanedPending <= 0) continue
            const { dead, live } = liveAndDead(depth)
            const worst = dead[0]
            const group = depth.group
            const liveName = live?.name ?? '<live-consumer>'
            const idleStr = worst?.idleMs != null ? formatAgeMs(worst.idleMs) : 'a while'
            out.push({
                id: `orphan:${name}`,
                severity: depth.orphanedPending > 1000 ? 'critical' : 'warning',
                category: 'Redis Streams',
                title: `${depth.orphanedPending.toLocaleString()} messages stranded on ${name}`,
                symptom: `A worker that stopped ~${idleStr} ago still holds ${depth.orphanedPending.toLocaleString()} delivered-but-unacknowledged messages. The live worker isn't reclaiming them, so this work will never run and the queue can't be trimmed.`,
                why: [
                    'A stats-service worker was killed mid-batch (deploy, OOM, or crash). Redis keeps every message a consumer has read in its pending list until it is acknowledged — they don’t disappear when the process dies.',
                    'The surviving workers reclaim stranded messages only once, at startup, and only a small batch per lane (the heavy lane reclaims one per restart) — so a large orphaned backlog is never drained by a running worker.',
                ],
                resolution: [
                    'Reclaim the stranded messages onto the live worker (repeat until the returned cursor is 0-0), then remove the dead consumer.',
                    'If the referenced jobs are obsolete (e.g. the data source was deleted), acknowledge-and-drop instead of reclaiming.',
                    'Durable fix: run PEL reclaim on an interval in the worker, not only at startup.',
                ],
                commands: [
                    { label: 'Reclaim to the live worker', cmd: `XAUTOCLAIM ${name} ${group} ${liveName} 60000 0 COUNT 2000` },
                    ...(worst?.name ? [{ label: 'Then drop the dead consumer', cmd: `XGROUP DELCONSUMER ${name} ${group} ${worst.name}` }] : []),
                ],
                evidence: [
                    ...(worst?.name ? [{ label: 'Dead consumer', value: worst.name }] : []),
                    { label: 'Idle', value: idleStr ?? '—' },
                    { label: 'Stranded', value: depth.orphanedPending.toLocaleString() },
                    { label: 'Group lag', value: String(depth.groupLag ?? '—') },
                ],
            })

            // Companion reassurance: high depth caused by the orphan, not a backlog.
            if ((depth.len ?? 0) > 5000 && (depth.groupLag ?? 0) === 0) {
                out.push({
                    id: `depth:${name}`,
                    severity: 'info',
                    category: 'Redis Streams',
                    title: `${name} depth looks high but isn't a live backlog`,
                    symptom: `Depth is ${depth.len?.toLocaleString()} while group lag is 0 — the group has already read every new entry. The depth is un-trimmed history, not unprocessed work.`,
                    why: [
                        'Trimming is PEL-safe: it can’t discard entries still sitting in a pending list. The orphaned messages above pin the trim point, so processed history accumulates behind them.',
                    ],
                    resolution: [
                        'Clear the orphaned pending entries (above). Trimming then advances on its own and the depth falls — no action needed on the depth itself.',
                    ],
                })
            }
        }

        // ── Dead-letter queues: why they failed + who's responsible ──
        for (const dlq of snap.streams.dlqs) {
            if (!dlq.len || dlq.len <= 0) continue
            const family = dlq.family
            const reasons = dlq.reasons ?? {}
            const topReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]
            const sources = dlq.topSources ?? []
            const blank = sources.filter(s => (s.workspaceId ?? '').startsWith('ws_blank_'))
            const why: string[] = []
            if (topReason?.[0] === 'max_delivery_attempts_exceeded') {
                why.push('Each of these jobs failed its retry limit and was parked in the dead-letter queue rather than retried forever.')
            }
            if (blank.length) {
                why.push(`The heaviest offenders are blank-workspace data sources (${blank.map(s => s.dataSourceId).slice(0, 2).join(', ')}) — a source that was created but whose provider is unreachable or was never connected, so every poll errors out.`)
            } else if (sources.length) {
                why.push(`A few data sources (${sources.slice(0, 2).map(s => s.dataSourceId).join(', ')}) account for most of the queue — a handful of broken sources usually dominate a DLQ.`)
            }
            out.push({
                id: `dlq:${family}`,
                severity: dlq.len > 50 ? 'warning' : 'info',
                category: 'Redis Streams',
                title: `${dlq.len} messages dead-lettered on ${dlq.name}`,
                symptom: `${dlq.len} job${dlq.len === 1 ? '' : 's'} exhausted their retries` +
                    (dlq.oldestAgeMs != null ? `, oldest ${formatAgeMs(dlq.oldestAgeMs)} old` : '') +
                    (topReason ? `. Dominant reason: ${topReason[0].replace(/_/g, ' ')}.` : '.'),
                why,
                resolution: [
                    sources.length
                        ? `Check the top offender’s provider health (Providers → ${sources[0].dataSourceId}). If the source is dead or was never connected, disable its polling so it stops failing.`
                        : 'Inspect a sample of the dead-lettered jobs to find the failing source.',
                    'Once the underlying source is fixed, redrive the DLQ. If the jobs are obsolete, purge it.',
                ],
                commands: [
                    { label: 'Inspect the newest failures', cmd: `XREVRANGE ${dlq.name} + - COUNT 5` },
                ],
                evidence: [
                    ...(sources.slice(0, 3).map(s => ({
                        label: s.dataSourceId,
                        value: `${s.count}${(s.workspaceId ?? '').startsWith('ws_blank_') ? ' · blank ws' : ''}`,
                    }))),
                ],
            })
        }
    }

    // ── Projection failures ──
    for (const row of snap.projection?.worst ?? []) {
        if (!row.lastError) continue
        out.push({
            id: `proj:${row.graphId}`,
            severity: 'warning',
            category: 'Projection',
            title: `Projection failing for ${row.dataSourceLabel ?? row.dataSourceId}`,
            symptom: `This graph is ${row.lag} commit${row.lag === 1 ? '' : 's'} behind and its last projection attempt errored.`,
            why: [
                `The projector couldn’t apply the committed graph to its read cache${row.falkorProvider ? ` (provider ${row.falkorProvider})` : ''} — commonly an unreachable graph provider, an ontology/type mismatch that needs a full reseed, or an out-of-memory graph.`,
            ],
            resolution: [
                `Open the workspace’s Data health panel and trigger a rebuild (full reseed) for ${row.dataSourceLabel ?? row.dataSourceId}.`,
                'If the error mentions edge/type casing, a full reseed (watermark → 0) is required — incremental projection can’t retype an edge.',
            ],
            evidence: [
                { label: 'Error', value: row.lastError.slice(0, 120) },
                { label: 'Lag', value: `${row.lag} commits` },
            ],
        })
    }

    // ── Stats polling overdue ──
    if ((snap.statsPolling?.overdue ?? 0) > 0) {
        out.push({
            id: 'polling:overdue',
            severity: 'warning',
            category: 'Stats service',
            title: `${snap.statsPolling!.overdue} data source${snap.statsPolling!.overdue === 1 ? '' : 's'} not polling on schedule`,
            symptom: 'These sources haven’t been polled within twice their configured interval, so their stats are going stale.',
            why: [
                'Their poll jobs may be stuck in the orphaned pending backlog above, or their provider is failing every attempt (see the DLQ).',
                'A restarted stats-service that hasn’t caught up on its queue can also lag the schedule temporarily.',
            ],
            resolution: [
                'Clear any orphaned pending messages so the scheduler’s enqueues get processed.',
                'For sources that always fail, fix or disable the provider (see Stats polling errors).',
            ],
        })
    }

    // ── Per-service degraded / down (fold in reasons) ──
    for (const svc of snap.services) {
        if (svc.status !== 'degraded' && svc.status !== 'down') continue
        const reasons = Array.isArray(svc.detail.reasons)
            ? (svc.detail.reasons as unknown[]).filter((r): r is string => typeof r === 'string')
            : []
        const disk = svc.detail.disk as { usedPct?: number } | undefined
        const why: string[] = []
        const resolution: string[] = []
        const commands: DiagCommand[] = []

        if (svc.key === 'vizService' && (disk?.usedPct ?? 0) >= 80) {
            why.push('The Docker/host volume is filling. On this stack a full disk truncates in-flight writes and corrupts Redis RDB/AOF and Postgres WAL — there is a dev.sh guard at 80% for exactly this failure mode.')
            resolution.push('Reclaim space: docker system prune (images + build cache), or expand the volume. Don’t let it pass ~90%.')
            commands.push({ label: 'Reclaim Docker space', cmd: 'docker system prune -f && docker builder prune -f' })
        }
        if (reasons.some(r => r.includes('schema'))) {
            why.push('The schema-upgrade job hasn’t applied the newest migration (readiness reports schema_at_head = false).')
            resolution.push('Run the upgrade one-shot (alembic upgrade head) and restart the service.')
        }
        if (svc.key === 'aggregationWorker' && reasons.some(r => r.includes('stuck'))) {
            why.push('Jobs are marked running but their executor heartbeat has gone stale — a worker died mid-job. The reconciler will fail or auto-resume them.')
            resolution.push('Check the aggregation worker logs; a stuck job clears once the reconciler runs or the job is resumed.')
        }
        if (!why.length) {
            // Generic fallback so every degraded service still gets a card.
            why.push('One or more health signals for this component crossed a threshold — see the reasons below.')
            resolution.push('Inspect the component’s logs; the reasons list names the specific signal that tripped.')
        }
        out.push({
            id: `svc:${svc.key}`,
            severity: svc.status === 'down' ? 'critical' : 'warning',
            category: 'Service',
            title: `${svc.label} is ${svc.status}`,
            symptom: reasons.length ? reasons.join('; ') : (svc.error ?? 'Unreachable.'),
            why,
            resolution,
            commands: commands.length ? commands : undefined,
        })
    }

    return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])
}
