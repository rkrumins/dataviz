/**
 * A role's grant is global or in a workspace, and keeps only that scope's
 * permissions: a custom role carrying both never gives both, and the editor
 * says so.
 */
import { describe, expect, it } from 'vitest'

import { mixesScopes } from '../AdminPermissions'

describe('mixesScopes', () => {
    it('is a role with platform and workspace permissions', () => {
        expect(mixesScopes(['system:groups:manage', 'workspace:datasource:manage'])).toBe(true)
    })

    it('is not a role of one scope, or of none', () => {
        expect(mixesScopes(['workspace:datasource:manage', 'workspace:datasource:publish'])).toBe(false)
        expect(mixesScopes(['system:audit:read'])).toBe(false)
        expect(mixesScopes([])).toBe(false)
    })
})
