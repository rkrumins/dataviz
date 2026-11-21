/**
 * What testing a connection found: whether it answers, calls a tool and
 * makes embeddings — each with how long it took and what came back — and
 * what the assistant can therefore do with it.
 */
import { CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TestCheck, TestReport } from '@/services/aiAdminService'
import { CHECK_LABELS, detailText, toolsText } from './connectionFormat'

export function CheckList({ checks }: { checks: TestCheck[] }) {
    return (
        <ul className="space-y-1.5">
            {checks.map(c => {
                const detail = detailText(c.detail)
                return (
                    <li key={c.name} className="flex items-start gap-2 text-xs">
                        {c.ok
                            ? <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" aria-label="Passed" />
                            : <XCircle className="w-4 h-4 shrink-0 text-rose-500" aria-label="Failed" />}
                        <span className="min-w-0 flex-1">
                            <span className="font-semibold text-ink">{CHECK_LABELS[c.name] ?? c.name}</span>
                            {c.latencyMs != null && (
                                <span className="ml-2 tabular-nums text-ink-muted">{c.latencyMs.toLocaleString()} ms</span>
                            )}
                            {detail && (
                                <span className={cn('block break-words', c.ok ? 'text-ink-muted' : 'text-rose-600 dark:text-rose-400')}>
                                    {detail}{c.code ? ` (${c.code})` : ''}
                                </span>
                            )}
                        </span>
                    </li>
                )
            })}
        </ul>
    )
}

export function TestReportView({ report }: { report: TestReport }) {
    const caps = report.capabilities
    return (
        <div
            role="status"
            aria-label="Test result"
            className={cn(
                'rounded-xl border p-3 space-y-3',
                report.ok ? 'border-emerald-500/25 bg-emerald-500/[0.05]' : 'border-rose-500/25 bg-rose-500/[0.05]',
            )}
        >
            <p className="text-xs font-semibold text-ink">
                {report.ok ? 'The connection works.' : 'The connection could not answer.'}
            </p>
            <CheckList checks={report.checks} />
            {caps && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] border-t border-glass-border pt-2">
                    <dt className="text-ink-muted">Tools</dt>
                    <dd className="text-ink">{toolsText(caps)}</dd>
                    <dt className="text-ink-muted">Streaming</dt>
                    <dd className="text-ink">{caps.streaming ? 'Answers stream as they are written' : 'Answers arrive whole'}</dd>
                    <dt className="text-ink-muted">Embeddings</dt>
                    <dd className="text-ink">
                        {caps.embeddings
                            ? `Yes${caps.embeddingDimensions ? `, ${caps.embeddingDimensions.toLocaleString()} dimensions` : ''}`
                            : 'No — knowledge is searched by its words only'}
                    </dd>
                </dl>
            )}
        </div>
    )
}
