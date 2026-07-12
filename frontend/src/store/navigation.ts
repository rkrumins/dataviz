/**
 * Sidebar navigation model.
 *
 * The active nav section is DERIVED from the URL — the single source of truth —
 * via `tabForPath`, not held in a store. This makes the sidebar highlight
 * impossible to desync from the route.
 *
 * The previous design kept `activeTab` in a Zustand store synced by a
 * `useRouteSync` effect and set optimistically from various buttons. That
 * drifted two ways: routes the effect didn't map (e.g. /datasources) left a
 * stale highlight, and buttons that set the tab without navigating jumped the
 * highlight to a section the user wasn't actually on. Deriving from the URL
 * removes both classes of bug by construction.
 *
 * Returns `null` for routes that belong to no primary section (account pages,
 * docs, guide) so nothing is highlighted — rather than the wrong thing.
 */
export type NavigationTab = 'dashboard' | 'explore' | 'workspaces' | 'ingestion' | 'schema' | 'admin'

export function tabForPath(pathname: string): NavigationTab | null {
    if (pathname.startsWith('/dashboard')) return 'dashboard'
    if (pathname.startsWith('/explorer') || pathname.startsWith('/views')) return 'explore'
    // Data-source ("connection") detail pages belong to Ingestion — their own
    // back link points at /ingestion.
    if (pathname.startsWith('/ingestion') || pathname.startsWith('/datasources')) return 'ingestion'
    if (pathname.startsWith('/workspaces')) return 'workspaces'
    if (pathname.startsWith('/schema')) return 'schema'
    if (pathname.startsWith('/admin')) return 'admin'
    return null
}
