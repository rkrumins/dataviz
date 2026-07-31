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

import { cn } from '@/lib/utils'

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
