/**
 * PropertyStorageFinding — the property half of physical alignment.
 *
 * `PhysicalAlignmentSection` grades whether a source's LABELS are index-backed.
 * A property nested inside a container is unqueryable for exactly the same
 * reason — there is no field for FalkorDB to index — but it sat outside that
 * report entirely, so a source could be graded A while none of its properties
 * were searchable.
 *
 * Reads the same cached profile the Mapping tab does, so it costs no graph
 * work and stays consistent with what the tab will show.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2 } from 'lucide-react'

import {
    getPropertyStorage,
} from '@/services/propertyStorageService'

export function PropertyStorageFinding({ wsId, dataSourceId, onFix }: {
    wsId: string
    dataSourceId: string
    onFix?: () => void
}) {
    const { data, isLoading, isError } = useQuery({
        // Shared with PropertyMappingTab so a save or re-scan there refreshes
        // this line rather than leaving two views of one profile to drift.
        queryKey: ['property-storage', wsId, dataSourceId],
        queryFn: () => getPropertyStorage(wsId, dataSourceId),
        enabled: Boolean(wsId && dataSourceId),
        staleTime: 30_000,
    })

    // Rendering nothing while loading or on error is indistinguishable from
    // "all clear" — the one reading this panel could take away is the one
    // thing we don't know yet.
    if (isLoading) {
        return (
            <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
                Checking how properties are stored…
            </p>
        )
    }

    if (isError) {
        return (
            <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <HelpCircle className="w-3.5 h-3.5 flex-shrink-0" />
                Couldn't read the property profile — this check is unknown, not clear.
            </p>
        )
    }

    const report = data?.data
    // Not profiled yet, or profiled before this existed. Saying nothing beats
    // claiming a clean bill of health we haven't actually checked.
    if (!report) return null

    const needs = report.totals.needsAlignment
    if (needs.length === 0) {
        return (
            <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                Every property is a native field — all of them are searchable.
            </p>
        )
    }

    const affected = report.totals.affectedEstimate

    return (
        <p className="flex items-start gap-2 text-[11px] text-ink-secondary leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" />
            <span>
                {needs.length} type{needs.length === 1 ? '' : 's'}
                {' '}({needs.slice(0, 3).join(', ')}
                {needs.length > 3 ? `, +${needs.length - 3}` : ''}) keep their
                properties nested inside one field, so Advanced Search can't
                filter on them.
                {affected != null && affected > 0 && (
                    <span className="ml-1 text-ink-muted tabular-nums">
                        (≈{affected.toLocaleString()} nodes)
                    </span>
                )}
                {onFix && (
                    <>
                        {' '}
                        <button
                            onClick={onFix}
                            className="font-semibold text-indigo-500 hover:text-indigo-600 transition-colors"
                        >
                            Unpack them
                        </button>
                    </>
                )}
            </span>
        </p>
    )
}
