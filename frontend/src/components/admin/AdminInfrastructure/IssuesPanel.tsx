/**
 * IssuesPanel — one merged "what needs attention" list: unhealthy service
 * tiles, projection failures, stats-polling errors, non-empty DLQs, and
 * aggregation stuck jobs. Read-only; each entry says where it came from.
 */
import { CheckCircle2, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SystemStatusSnapshot } from '@/services/systemStatusService'
import { formatAgeMs, formatSince } from './meta'

interface Issue {
    source: string
    severity: 'down' | 'degraded'
    text: string
    when?: string | null
}

function collectIssues(snap: SystemStatusSnapshot): Issue[] {
    const issues: Issue[] = []

    for (const svc of snap.services) {
        if (svc.status !== 'degraded' && svc.status !== 'down') continue
        const reasons = Array.isArray(svc.detail.reasons)
            ? (svc.detail.reasons as unknown[]).filter((r): r is string => typeof r === 'string')
            : []
        issues.push({
            source: svc.label,
            severity: svc.status,
            text: reasons.length ? reasons.join('; ') : (svc.error ?? 'unreachable'),
        })
    }

    for (const row of snap.projection?.worst ?? []) {
        if (!row.lastError) continue
        issues.push({
            source: 'Projection',
            severity: 'degraded',
            text: `${row.dataSourceId}: ${row.lastError}`,
            when: formatSince(row.lastProjectedAt),
        })
    }

    for (const err of snap.statsPolling?.recentErrors ?? []) {
        issues.push({
            source: 'Stats polling',
            severity: 'degraded',
            text: `${err.label ?? err.dataSourceId}: ${err.lastError}`,
            when: formatSince(err.lastPolledAt),
        })
    }

    const aggDlq = snap.streams?.aggregation.dlq
    if ((aggDlq?.len ?? 0) > 0) {
        issues.push({
            source: 'Aggregation DLQ',
            severity: 'degraded',
            text: `${aggDlq!.len} dead-lettered message(s)` +
                (aggDlq!.oldestAgeMs != null ? `, oldest ${formatAgeMs(aggDlq!.oldestAgeMs)}` : ''),
        })
    }
    const insDlq = snap.streams?.insights.dlq
    if ((insDlq?.len ?? 0) > 0) {
        issues.push({
            source: 'Insights DLQ',
            severity: 'degraded',
            text: `${insDlq!.len} dead-lettered message(s)` +
                (insDlq!.oldestAgeMs != null ? `, oldest ${formatAgeMs(insDlq!.oldestAgeMs)}` : ''),
        })
    }

    if ((snap.aggregationJobs?.stuckJobs ?? 0) > 0) {
        issues.push({
            source: 'Aggregation jobs',
            severity: 'degraded',
            text: `${snap.aggregationJobs!.stuckJobs} running job(s) with no live executor heartbeat`,
        })
    }

    return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'down' ? -1 : 1))
}

export function IssuesPanel({ snapshot }: { snapshot: SystemStatusSnapshot }) {
    const issues = collectIssues(snapshot)

    return (
        <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden">
            <div className="px-5 pt-4 pb-3 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-indigo-500" />
                <div>
                    <h2 className="text-sm font-semibold text-ink">Needs attention</h2>
                    <p className="text-[11px] text-ink-muted">Failures and warnings gathered from every component, most severe first.</p>
                </div>
            </div>
            {issues.length === 0 ? (
                <div className="px-5 pb-5 flex items-center gap-2 text-xs text-ink-muted">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    Nothing needs attention right now.
                </div>
            ) : (
                <ul className="pb-2">
                    {issues.map((issue, i) => (
                        <li key={`${issue.source}-${i}`} className="px-5 py-2.5 border-t border-glass-border flex items-start gap-3">
                            <span className={cn('mt-1 w-2 h-2 rounded-full shrink-0',
                                issue.severity === 'down' ? 'bg-red-500' : 'bg-amber-400')} />
                            <div className="min-w-0">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{issue.source}</span>
                                {issue.when && <span className="ml-2 text-[10px] text-ink-muted">{issue.when}</span>}
                                <p className="text-xs text-ink-secondary break-words leading-snug mt-0.5">{issue.text}</p>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
