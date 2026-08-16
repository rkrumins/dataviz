/**
 * StartHereStrip — the guided entry to the fleet table when something
 * needs a person. Names the attention count, the dominant failure cause,
 * and one-click jumps into those facets.
 */
import { Compass, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FreshnessSummary } from '@/services/freshnessService'
import type { FailureFacet, StatusFacet } from './freshnessTriage'
import {
    FAILURE_CATEGORY_LABEL,
    countFailuresByCategory,
} from './failureGuidance'
import type { FreshnessRow } from '@/services/freshnessService'

export function StartHereStrip({
    summary, rows, status, failureFacet, onStatus, onFailure, onClear,
}: {
    summary: FreshnessSummary | null | undefined
    rows: FreshnessRow[]
    status: StatusFacet
    failureFacet: FailureFacet
    onStatus: (facet: StatusFacet) => void
    onFailure: (facet: FailureFacet) => void
    onClear: () => void
}) {
    const attention = summary?.needsAttention ?? 0
    const suspended = summary?.suspended ?? 0
    const byCause = countFailuresByCategory(rows)
    const topCause = byCause[0]
    const failedOnPage = byCause.reduce((n, c) => n + c.count, 0)

    if (attention <= 0 && failedOnPage <= 0 && !failureFacet && status !== 'needsAttention') {
        return null
    }

    const guided = attention > 0 || failedOnPage > 0
    if (!guided && !failureFacet) return null

    return (
        <section
            className={cn(
                'rounded-xl border px-4 py-3.5',
                attention > 0
                    ? 'border-amber-500/30 bg-amber-500/[0.06]'
                    : 'border-glass-border bg-canvas-elevated',
            )}
        >
            <div className="flex flex-wrap items-start gap-3">
                <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-300 shrink-0">
                    <Compass className="w-4 h-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-2">
                    <div>
                        <h2 className="text-sm font-semibold text-ink">Start here</h2>
                        <p className="text-[12px] text-ink-muted mt-0.5">
                            {attention > 0
                                ? `${attention.toLocaleString()} source${attention === 1 ? '' : 's'} need attention`
                                : 'Filter the fleet to what matters next.'}
                            {failedOnPage > 0 && topCause && (
                                <>
                                    {' · '}
                                    {failedOnPage.toLocaleString()} failed
                                    {topCause.count > 0 && (
                                        <> ({topCause.count.toLocaleString()} {FAILURE_CATEGORY_LABEL[topCause.category].toLowerCase()})</>
                                    )}
                                </>
                            )}
                            {suspended > 0 && (
                                <> · {suspended.toLocaleString()} need a person</>
                            )}
                        </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {attention > 0 && (
                            <Chip
                                active={status === 'needsAttention' && !failureFacet}
                                onClick={() => {
                                    onFailure('')
                                    onStatus(status === 'needsAttention' ? '' : 'needsAttention')
                                }}
                            >
                                Review attention
                            </Chip>
                        )}
                        {topCause && topCause.count > 1 && (
                            <Chip
                                active={failureFacet === topCause.category}
                                onClick={() => onFailure(
                                    failureFacet === topCause.category ? '' : topCause.category,
                                )}
                            >
                                Same cause: {FAILURE_CATEGORY_LABEL[topCause.category]} → {topCause.count}
                            </Chip>
                        )}
                        {suspended > 0 && (
                            <Chip
                                active={status === 'suspended'}
                                onClick={() => {
                                    onFailure('')
                                    onStatus(status === 'suspended' ? '' : 'suspended')
                                }}
                            >
                                Needs a person
                            </Chip>
                        )}
                        {(status || failureFacet) && (
                            <button
                                type="button"
                                onClick={onClear}
                                className="inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[11px] font-semibold text-ink-muted hover:text-ink"
                            >
                                <X className="w-3 h-3" /> Clear
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </section>
    )
}

function Chip({
    children, active, onClick,
}: {
    children: React.ReactNode
    active: boolean
    onClick: () => void
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={cn(
                'inline-flex items-center h-7 px-2.5 rounded-lg text-[11px] font-semibold border transition-colors',
                active
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'bg-canvas text-ink border-glass-border hover:border-indigo-500/40 hover:text-indigo-700 dark:hover:text-indigo-300',
            )}
        >
            {children}
        </button>
    )
}
