/**
 * UsageSection — the place on a tab for figures from the usage document.
 *
 * The summary draws the tab at once; the usage document is a second request
 * that can arrive later. So its sections hold their place with a skeleton
 * rather than holding the whole tab back, and a failure says so where the
 * figures would have been instead of taking the summary's figures with it.
 */
import type { AnalyticsUsageDoc } from '@/services/analyticsService'
import type { AnalyticsUsageState } from '@/hooks/useAnalytics'

export function UsageSection({
    usage, children,
}: {
    /** Absent where a tab is drawn without it, as in a test. */
    usage?: AnalyticsUsageState
    children: (doc: AnalyticsUsageDoc) => React.ReactNode
}) {
    if (!usage) return null
    if (usage.data) return <>{children(usage.data)}</>
    if (usage.error) {
        return (
            <p role="status" className="rounded-xl border border-glass-border bg-canvas-elevated px-4 py-5 text-center text-xs text-ink-muted">
                These figures could not be loaded just now. Everything else on this tab is unaffected.
            </p>
        )
    }
    return (
        <div
            aria-hidden
            className="h-56 rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] animate-pulse"
        />
    )
}
