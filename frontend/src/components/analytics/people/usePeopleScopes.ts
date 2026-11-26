import { useMemo } from 'react'

import { useAnalyticsAccess } from '@/hooks/useAnalyticsAccess'
import { checkPermission, usePermissionClaims } from '@/store/auth'
import { useWorkspacesStore } from '@/store/workspaces'
import type { PeopleScopeOption } from './PeopleTab'

/**
 * What a reader may report on in the People tab: everything, for an analytics
 * administrator; otherwise the workspaces they administer. A convenience for
 * the picker only — the server decides, and refuses anything else.
 */
export function usePeopleScopes(): { scopes: PeopleScopeOption[]; fallback: string | null } {
    const { privileged } = useAnalyticsAccess()
    const claims = usePermissionClaims()
    const workspaces = useWorkspacesStore((s) => s.workspaces)
    return useMemo(() => {
        const named = [...workspaces].sort((a, b) => a.name.localeCompare(b.name))
        if (privileged) {
            return {
                scopes: [{ id: null, name: 'All workspaces' }, ...named.map((w) => ({ id: w.id, name: w.name }))],
                fallback: null,
            }
        }
        const mine = named.filter((w) => checkPermission(claims, 'workspace:admin', w.id))
        return { scopes: mine.map((w) => ({ id: w.id, name: w.name })), fallback: mine[0]?.id ?? null }
    }, [privileged, claims, workspaces])
}
