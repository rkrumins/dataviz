/**
 * Deep link to a data source's Mapping tab.
 *
 * Several surfaces detect that a graph's properties are trapped in a nested
 * container — the search diagnostics, the entity drawer's empty state, the
 * property browser — and each of them used to end in a dead end: a shell
 * command, or nothing at all. They all now point here, at the one screen that
 * can actually fix it.
 *
 * The `dsTab` param is what makes the link land on Mapping rather than
 * Overview; see `WorkspaceDetailPage`'s handling of it.
 */
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { cn } from '@/lib/utils'
import { getPropertyStorage } from '@/services/propertyStorageService'

/**
 * Returns `null` when the workspace isn't known, so callers can fall back to
 * plain prose rather than render a link that goes nowhere.
 */
export function propertyMappingHref(
    wsId: string | null | undefined,
    dataSourceId?: string | null,
): string | null {
    if (!wsId) return null
    const base = `/workspaces/${encodeURIComponent(wsId)}`
    return dataSourceId
        // Both known: open the drawer straight onto Mapping.
        ? `${base}?ds=${encodeURIComponent(dataSourceId)}&dsTab=mapping`
        // Workspace only: land on its sources list — still a step forward,
        // and better than naming a fix the reader can't reach.
        : base
}

export function PropertyMappingLink({
    wsId, dataSourceId, label = 'Configure property mapping', className,
}: {
    wsId: string | null | undefined
    dataSourceId?: string | null
    label?: string
    className?: string
}) {
    const href = propertyMappingHref(wsId, dataSourceId)
    if (!href) return null
    return (
        <Link
            to={href}
            className={cn(
                'inline-flex items-center gap-1 font-semibold text-indigo-500',
                'hover:text-indigo-600 transition-colors',
                className,
            )}
        >
            {label}
            <ArrowRight className="w-3 h-3" />
        </Link>
    )
}

/**
 * The entity drawer's empty-Properties explanation.
 *
 * "No properties yet" is only true when the node really has none. On a source
 * that nests, it's false in the way that costs the most: the properties are
 * there, the platform just can't see them. This reads the same cached profile
 * the Mapping tab does — mounted only in the empty branch, so the common case
 * pays nothing — and names the actual key when the profile knows it.
 */
export function EmptyPropertiesHint({ wsId, dataSourceId }: {
    wsId: string | null | undefined
    dataSourceId?: string | null
}) {
    const { data } = useQuery({
        queryKey: ['property-storage', wsId, dataSourceId],
        queryFn: () => getPropertyStorage(wsId!, dataSourceId!),
        enabled: Boolean(wsId && dataSourceId),
        staleTime: 30_000,
        retry: false,
    })

    if (!propertyMappingHref(wsId, dataSourceId)) return null

    const report = data?.data
    const nested = report?.totals.needsAlignment ?? []
    const key = report
        ? Array.from(new Set(
            Object.values(report.labels).flatMap(l => l.containerKeys),
        ))[0]
        : undefined

    return (
        <p className="text-[11px] text-ink-muted leading-relaxed">
            {nested.length > 0 && key ? (
                <>
                    This source keeps properties nested under{' '}
                    <code className="font-mono text-ink">{key}</code> on{' '}
                    {nested.length} type{nested.length === 1 ? '' : 's'}, so they
                    stay hidden until it's unpacked.{' '}
                </>
            ) : (
                <>
                    If this source nests its properties under a container key,
                    they stay hidden until it's mapped.{' '}
                </>
            )}
            <PropertyMappingLink
                wsId={wsId}
                dataSourceId={dataSourceId}
                label={nested.length > 0 ? 'Unpack them' : 'Check property mapping'}
                className="text-[11px]"
            />
        </p>
    )
}
