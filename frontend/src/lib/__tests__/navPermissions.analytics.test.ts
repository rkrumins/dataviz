/**
 * Pins that `system:analytics:read` actually opens the Analytics section.
 *
 * The permission shipped in three places and was wired into a fourth nowhere:
 * the server treats it as privileged (`analytics_scope.PRIVILEGED_PERMISSIONS`),
 * but the nav spec the CLIENT reads listed only the three older permissions.
 * `useAnalyticsAccess` derives `privileged` from that spec, so a custom role
 * granted only the new permission was not merely missing a menu entry —
 * `RequireAnalytics` refused the route outright and explained that the section
 * was not open on this deployment, which was false: the server would have
 * served them the whole, unredacted document.
 *
 * Tested on the pure predicate rather than through a render, because that is
 * where the decision is actually made and it is the same function the sidebar
 * and the route guard both reach.
 */
import { describe, expect, it } from 'vitest'

import { checkNavPermission, type PermissionClaims } from '@/store/auth'
import { DEFAULT_SIDEBAR_PERMISSIONS } from '@/lib/navPermissions'

const claimsWith = (...global: string[]): PermissionClaims => ({
    sid: 'sess_test', global, ws: {},
})

const ANALYTICS = DEFAULT_SIDEBAR_PERMISSIONS.analytics

describe('the Analytics nav spec', () => {
    it('admits the dedicated analytics permission on its own', () => {
        expect(checkNavPermission(claimsWith('system:analytics:read'), ANALYTICS))
            .toBe(true)
    })

    it('still admits the three audiences that predate it', () => {
        for (const perm of [
            'system:admin', 'system:org-admin', 'system:audit:read',
        ]) {
            expect(checkNavPermission(claimsWith(perm), ANALYTICS)).toBe(true)
        }
    })

    it('admits nobody else — the flag opens the redacted section, not this', () => {
        expect(checkNavPermission(claimsWith(), ANALYTICS)).toBe(false)
        expect(checkNavPermission(claimsWith('workspace:view:read'), ANALYTICS))
            .toBe(false)
    })

    it('lists exactly what the server calls privileged', () => {
        // Mirrors backend/app/services/analytics_scope.py PRIVILEGED_PERMISSIONS
        // and backend/app/services/nav_catalogue.py. All three are asserted
        // against each other on the backend side; this is the client's half.
        expect(new Set(ANALYTICS.kind === 'anyPerm' ? ANALYTICS.perms : []))
            .toEqual(new Set([
                'system:analytics:read',
                'system:admin',
                'system:org-admin',
                'system:audit:read',
            ]))
    })
})
