/**
 * deriveViewCapabilities: the server's access envelope wins when
 * present; the legacy claim-derived rules keep the app working against
 * a backend that predates the envelope.
 */
import { describe, expect, it } from 'vitest'

import type { ViewAccess } from '@/services/viewApiService'
import { deriveViewCapabilities } from '../viewAccess'

const LEGACY_NONE = {
    isCreator: false,
    canEditPerm: false,
    canAdminPerm: false,
    canPublishPerm: false,
}

describe('envelope wins', () => {
    it('projects the envelope verbatim, readOnlyData from dataAccess', () => {
        const access: ViewAccess = {
            canEdit: true,
            canManageGrants: false,
            canChangeVisibility: false,
            canPublish: false,
            accessVia: 'grant',
            dataAccess: 'readonly',
        }
        const caps = deriveViewCapabilities(access, {
            ...LEGACY_NONE, isCreator: true, canAdminPerm: true,
        })
        expect(caps).toEqual({
            canEdit: true,
            canManageGrants: false,
            canChangeVisibility: false,
            canPublish: false,
            readOnlyData: true,
        })
    })

    it('full data access is never read-only', () => {
        const access: ViewAccess = {
            canEdit: true,
            canManageGrants: true,
            canChangeVisibility: true,
            canPublish: true,
            accessVia: 'owner',
            dataAccess: 'full',
        }
        expect(deriveViewCapabilities(access, LEGACY_NONE).readOnlyData).toBe(false)
    })
})

describe('legacy fallback (no envelope)', () => {
    it('mirrors the old canvas gating: edit = view:edit ∨ creator; share = admin ∨ creator', () => {
        const creator = deriveViewCapabilities(null, {
            ...LEGACY_NONE, isCreator: true,
        })
        expect(creator.canEdit).toBe(true)
        expect(creator.canManageGrants).toBe(true)
        expect(creator.canChangeVisibility).toBe(true)
        expect(creator.canPublish).toBe(false)
        expect(creator.readOnlyData).toBe(false)

        const editorPerm = deriveViewCapabilities(undefined, {
            ...LEGACY_NONE, canEditPerm: true,
        })
        expect(editorPerm.canEdit).toBe(true)
        expect(editorPerm.canManageGrants).toBe(false)

        const admin = deriveViewCapabilities(null, {
            ...LEGACY_NONE, canAdminPerm: true, canPublishPerm: true,
        })
        expect(admin.canManageGrants).toBe(true)
        expect(admin.canPublish).toBe(true)
    })
})
