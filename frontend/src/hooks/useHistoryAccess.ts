/**
 * Who may read counts history.
 *
 * Mirrors the backend gate exactly. History reads moved off the platform-admin
 * `/admin/insights` router onto the Ingestion-surface gate
 * (`_require_ingestion_read`), because a workspace data source manager could
 * already see a source's freshness and its current counts but not how those
 * counts MOVED — which hid the history card from the very people who onboard
 * the data.
 *
 * Kept in one place, and asserted against the backend's permission list in
 * `useHistoryAccess.test.ts`, because a front end that gates more tightly than
 * the API renders an empty surface to someone the server would have answered,
 * and one that gates more loosely renders a 403.
 *
 * `system:admin` short-circuits, matching `has_permission_any_workspace`.
 */
import { useAnyPermission, useAnyWorkspacePermission } from '@/store/auth'

/** Mirrors `_INGESTION_READ_PERMS` in
 *  `backend/app/api/v1/endpoints/aggregation.py`, in the same order. Both
 *  admin roles belong in it: the backend checks all four through
 *  `has_permission_any_workspace`, so omitting `system:org-admin` here would
 *  blank the surface for someone the server answers happily. */
export const INGESTION_READ_PERMS = [
    'system:admin',
    'system:org-admin',
    'workspace:provider:read',
    'workspace:datasource:manage',
] as const

export function useCanReadHistory(): boolean {
    // Rules of Hooks: call every probe unconditionally, never short-circuit
    // with `||` — the hook count has to stay stable when the admin flag flips.
    // The Ingestion page documents the same constraint.
    //
    // The two `system:` roles are global claims; the two `workspace:` ones are
    // satisfied by a binding in ANY workspace, which is what
    // `has_permission_any_workspace` does on the other side.
    const isOperator = useAnyPermission(['system:admin', 'system:org-admin'])
    const hasProviderRead = useAnyWorkspacePermission('workspace:provider:read')
    const hasDataSourceManage = useAnyWorkspacePermission('workspace:datasource:manage')
    return isOperator || hasProviderRead || hasDataSourceManage
}

/** True for the platform operator personas — the readers whose scope is the
 *  whole deployment rather than the workspaces they happen to be bound to.
 *  Fleet-wide surfaces use this to decide what they may offer, not merely how
 *  to style themselves. */
export function useIsPlatformOperator(): boolean {
    return useAnyPermission(['system:admin', 'system:org-admin'])
}

/** Changing retention and alert policy stays platform-admin: it is fleet-wide
 *  configuration, not a per-workspace view. The dialog renders read-only for
 *  everyone else, mirroring the aggregation settings modal. */
export function useCanEditHistoryPolicy(): boolean {
    return useAnyPermission(['system:admin'])
}
