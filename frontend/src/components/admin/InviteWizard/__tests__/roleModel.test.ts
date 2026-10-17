/**
 * workspace_publisher (ACCESS R0) is a workspace-template role. If the FE
 * did not know that, the Invite and Create-user wizards would offer it as an
 * organisation-wide tier, and the global binding they create is dropped by
 * the resolver, so the invitee would get nothing.
 */
import { describe, it, expect } from 'vitest'
import { roleIsPrivileged, roleNeedsWorkspace } from '../roleModel'
import { roleVisualFor } from '@/lib/roleVisual'
import { SYSTEM_ROLE_LABELS } from '@/store/auth'
import type { RoleDefinitionResponse } from '@/services/permissionsService'

const PUBLISHER_GRANTS = [
    'workspace:catalog:read', 'workspace:datasource:manage', 'workspace:datasource:publish',
    'workspace:datasource:read', 'workspace:ontology:read', 'workspace:provider:read',
    'workspace:view:create', 'workspace:view:delete', 'workspace:view:edit', 'workspace:view:read',
]

const publisher = {
    name: 'workspace_publisher', description: '', permissions: PUBLISHER_GRANTS,
    isSystem: true, scopeType: 'global', scopeId: null,
} as unknown as RoleDefinitionResponse

describe('workspace_publisher', () => {
    it('needs a workspace, so the wizards do not offer it org-wide', () => {
        expect(roleNeedsWorkspace(publisher)).toBe(true)
    })

    it('has its own label, not the custom-role fallback', () => {
        expect(roleVisualFor('workspace_publisher').label).toBe('Publisher')
        expect(SYSTEM_ROLE_LABELS['workspace_publisher']).toBe('Publisher')
    })

    // Regression guard: passes before R0 too.
    it('is not privileged, so an open link may carry it', () => {
        expect(roleIsPrivileged(PUBLISHER_GRANTS)).toBe(false)
    })
})
