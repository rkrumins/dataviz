/**
 * RBAC Search Service — Phase 4.5 unified entity-finder.
 *
 * Maps to ``GET /api/v1/admin/rbac/search``. Returns a mixed list of
 * hits across users / groups / workspaces / roles / permissions,
 * ranked by score then alphabetic.
 */
import { authFetch } from './apiClient'


export type RBACSearchEntityType =
    | 'user' | 'group' | 'workspace' | 'role' | 'permission'


export interface RBACSearchHit {
    type: RBACSearchEntityType
    id: string
    displayName: string
    secondary: string | null
    /** Server-side score: 3=exact id, 2=prefix, 1=substring. */
    score: number
}


export const rbacSearchService = {
    search(
        q: string,
        opts?: { types?: RBACSearchEntityType[] },
    ): Promise<RBACSearchHit[]> {
        const params = new URLSearchParams({ q })
        if (opts?.types && opts.types.length > 0) {
            params.set('types', opts.types.join(','))
        }
        return authFetch<RBACSearchHit[]>(
            `/api/v1/admin/rbac/search?${params.toString()}`,
        )
    },
}
