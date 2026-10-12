/**
 * Loading skeleton — structurally mirrors the loaded Overview so the real
 * content swaps in without a reflow.
 *
 * Only shown on the FIRST load. A range change holds the previous render at
 * reduced opacity instead (see `useAnalytics`' `placeholderData`), because a
 * skeleton flash on every filter click is worse than a brief stale number.
 */
export function AnalyticsSkeleton() {
    const block = 'rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] animate-pulse'
    return (
        <div className="space-y-5" aria-hidden>
            <div className={`${block} h-28`} />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[0, 1, 2, 3].map((i) => <div key={i} className={`${block} h-32`} />)}
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {[0, 1].map((i) => <div key={i} className={`${block} h-72`} />)}
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                {[0, 1, 2].map((i) => <div key={i} className={`${block} h-64`} />)}
            </div>
        </div>
    )
}
