/**
 * How much the assistant is used — questions and tokens per day over 30
 * days — and what people thought of the answers, with the latest answers
 * marked unhelpful and why.
 */
import { useQuery } from '@tanstack/react-query'
import { MessageSquareText, ThumbsDown, ThumbsUp } from 'lucide-react'
import { BarSeriesChart } from '@/components/analytics/charts/BarSeriesChart'
import { ChartFrame } from '@/components/analytics/charts/ChartFrame'
import { ChartTable } from '@/components/analytics/charts/ChartTable'
import { EmptyState, Skeleton } from '@/components/ui/primitives'
import { DateTime } from '@/components/ui/DateTime'
import { SsoCard } from '@/components/admin/sso/ui/SsoCard'
import { ErrorBanner } from '@/components/admin/sso/tabs/ErrorBanner'
import { shortDate } from '@/lib/formatMetric'
import { aiAdminService, AI_ADMIN_KEYS } from '@/services/aiAdminService'

export function UsageTab() {
    const usageQ = useQuery({ queryKey: AI_ADMIN_KEYS.usage, queryFn: () => aiAdminService.usage(30) })
    if (usageQ.isLoading) return <div className="space-y-3" aria-label="Loading usage"><Skeleton className="h-56 w-full" /><Skeleton className="h-56 w-full" /></div>
    if (!usageQ.data) return <ErrorBanner message={(usageQ.error as Error | null)?.message ?? 'Usage could not be read.'} />
    const { days, feedback, recentDown } = usageQ.data
    const buckets = days.map(d => d.day)
    const rows = buckets.map(b => shortDate(b, true))
    const requests = days.map(d => d.requests)
    const tokens = days.map(d => d.inputTokens + d.outputTokens)
    const nothing = requests.every(v => v === 0)

    return (
        <div className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
                <ChartFrame
                    title="Questions per day"
                    subtitle="Last 30 days, UTC"
                    isEmpty={nothing}
                    emptyLabel="No questions in the last 30 days."
                    table={<ChartTable rowLabel="Day" rows={rows} columns={[{ key: 'q', label: 'Questions', values: requests }]} />}
                >
                    <BarSeriesChart buckets={buckets} values={requests} label="questions" height={180} />
                </ChartFrame>
                <ChartFrame
                    title="Tokens per day"
                    subtitle="Sent and received together, last 30 days, UTC"
                    isEmpty={nothing}
                    emptyLabel="No tokens used in the last 30 days."
                    table={
                        <ChartTable rowLabel="Day" rows={rows} columns={[
                            { key: 'in', label: 'Sent', values: days.map(d => d.inputTokens) },
                            { key: 'out', label: 'Received', values: days.map(d => d.outputTokens) },
                        ]} />
                    }
                >
                    <BarSeriesChart buckets={buckets} values={tokens} label="tokens" slot={2} height={180} />
                </ChartFrame>
            </div>

            <SsoCard
                icon={MessageSquareText}
                title="What people thought"
                blurb="People rate an answer with a thumb. Unhelpful answers with a comment are where the guide, the vocabulary or the data sharing most often need work."
            >
                <div className="flex items-center gap-6 mb-4">
                    <span className="flex items-center gap-2 text-sm">
                        <ThumbsUp className="w-4 h-4 text-emerald-500" aria-hidden />
                        <span className="font-bold tabular-nums text-ink">{feedback.up.toLocaleString()}</span>
                        <span className="text-xs text-ink-muted">helpful</span>
                    </span>
                    <span className="flex items-center gap-2 text-sm">
                        <ThumbsDown className="w-4 h-4 text-rose-500" aria-hidden />
                        <span className="font-bold tabular-nums text-ink">{feedback.down.toLocaleString()}</span>
                        <span className="text-xs text-ink-muted">not helpful</span>
                    </span>
                </div>
                {recentDown.length === 0 ? (
                    <EmptyState compact icon={ThumbsDown} title="No answers marked unhelpful" />
                ) : (
                    <ul className="divide-y divide-glass-border rounded-xl border border-glass-border" aria-label="Recent unhelpful answers">
                        {recentDown.map(r => (
                            <li key={r.messageId} className="px-4 py-3 text-xs">
                                <div className="flex items-start justify-between gap-3">
                                    <p className="font-semibold text-ink min-w-0">{r.question || 'A question'}</p>
                                    <DateTime at={r.createdAt} className="shrink-0 text-[10px] text-ink-muted" />
                                </div>
                                <p className="mt-1 text-ink-secondary">{r.comment || <span className="text-ink-muted">No comment</span>}</p>
                            </li>
                        ))}
                    </ul>
                )}
            </SsoCard>
        </div>
    )
}
