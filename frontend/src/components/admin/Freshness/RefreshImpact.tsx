/**
 * RefreshImpact — what the chosen scope will actually do, before it does it.
 *
 * The old copy ("can take several minutes and adds load on the provider")
 * understated a verb that clears cached data and queues an aggregation job
 * for EVERY live source under the provider — on the observed fleet, 31 of
 * them, several of which have previously failed on graph-store memory.
 */
import { AlertTriangle, Clock, Eraser, RotateCcw } from 'lucide-react'
import type { RefreshScope } from '@/services/freshnessService'

/** Scopes that queue aggregation jobs — the expensive, slow, guarded ones. */
export function scopeRebuilds(scope: RefreshScope, force: boolean): boolean {
    return scope === 'rollups' || scope === 'full' || (scope === 'auto' && force)
}

function clearsCache(scope: RefreshScope): boolean {
    return scope === 'full' || scope === 'clear' || scope === 'read-caches'
}

/** The change-gated scope does neither of the above on its own: it checks
 *  each source's fingerprint and acts only where data actually changed.
 *  Without this line the default scope renders a "This will:" header over
 *  an empty list. */
function isChangeGated(scope: RefreshScope, force: boolean): boolean {
    return scope === 'auto' && !force
}

export function RefreshImpact({ scope, force, emptyLabel = 'every live source using this provider' }: {
    scope: RefreshScope
    force: boolean
    /** Who "this" refers to below. There is no authoritative source count to
     *  show instead: the only pre-batch totals available are workspace/
     *  provider-filterable, while the batch itself enumerates every live
     *  source with no such filter — a number here could understate what
     *  will actually run, which is worse than no number on a destructive
     *  confirmation. */
    emptyLabel?: string
}) {
    const rebuilds = scopeRebuilds(scope, force)

    return (
        <div className="mb-4 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2.5 text-xs text-ink-secondary">
            <p className="mb-2 font-medium text-ink">This will, for {emptyLabel}:</p>
            <ul className="space-y-1">
                {isChangeGated(scope, force) && (
                    <li className="flex items-start gap-2">
                        <RotateCcw className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-500" />
                        check each source and refresh only the ones whose data changed
                        <span className="text-ink-muted">(unchanged sources cost nothing)</span>
                    </li>
                )}
                {clearsCache(scope) && (
                    <li className="flex items-start gap-2">
                        <Eraser className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-400" />
                        clear cached canvas data <span className="text-ink-muted">(users see slower first loads)</span>
                    </li>
                )}
                {rebuilds && (
                    <>
                        <li className="flex items-start gap-2">
                            <RotateCcw className="w-3.5 h-3.5 shrink-0 mt-0.5 text-indigo-500" />
                            queue a lineage rebuild job <span className="text-ink-muted">(run with limited concurrency)</span>
                        </li>
                        <li className="flex items-start gap-2">
                            <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-500" />
                            minutes to tens of minutes per source
                        </li>
                    </>
                )}
            </ul>
            {rebuilds && (
                <p className="mt-2 flex items-start gap-2 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    Rebuilds continue in the background if you close this.
                </p>
            )}
        </div>
    )
}
