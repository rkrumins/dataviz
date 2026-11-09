/**
 * Roles that change data but can't publish it, and adding publish to one.
 *
 * Publish arrived after manage, and no custom role or Workspace member got it:
 * people, service accounts and keys on those roles import into drafts and meet
 * 403 publish_required. The advisory lists them, and adds publish to one role
 * only once an admin has seen who gains it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/permissionsService', () => ({
    permissionsService: { previewRoleUpdate: vi.fn(), updateRole: vi.fn() },
}))

import { PublishGapAdvisory, publishGapRoles } from '../PublishGapAdvisory'
import { permissionsService, type RoleDefinitionResponse } from '@/services/permissionsService'

const role = (name: string, permissions: string[], over: Partial<RoleDefinitionResponse> = {}): RoleDefinitionResponse => ({
    name, description: null, scopeType: 'global', scopeId: null, isSystem: false, permissions,
    createdAt: null, updatedAt: null, createdBy: null, bindingCount: 2, isModified: false,
    lockedPermissions: [], ...over,
})

const MANAGE = 'workspace:datasource:manage'
const PUBLISH = 'workspace:datasource:publish'
const ROLES = [
    role('pipeline_ops', ['workspace:datasource:read', MANAGE]),
    role('workspace_member', ['workspace:datasource:read', MANAGE], { isSystem: true }),
    role('workspace_publisher', [MANAGE, PUBLISH], { isSystem: true }),
    role('workspace_admin', ['workspace:admin', MANAGE], { isSystem: true }),
    role('workspace_viewer', ['workspace:datasource:read'], { isSystem: true }),
]

beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(permissionsService.previewRoleUpdate).mockResolvedValue({
        affectedUsers: 2, affectedWorkspaces: 1, gainedPerms: [PUBLISH], lostPerms: [], userImpact: [],
    })
    vi.mocked(permissionsService.updateRole).mockResolvedValue(ROLES[0])
})

describe('roles that change data but can’t publish it', () => {
    it('are those with manage and neither publish nor workspace admin', () => {
        expect(publishGapRoles(ROLES).map((r) => r.name)).toEqual(['pipeline_ops', 'workspace_member'])
    })

    it('are listed, with a word against giving every member publish', () => {
        render(<PublishGapAdvisory roles={ROLES} onChanged={vi.fn()} />)
        const advisory = screen.getByRole('region', { name: /change data but don't publish/i })
        expect(advisory).toHaveTextContent('2 roles change data but can’t publish it')
        expect(advisory).toHaveTextContent('403 publish_required')
        expect(within(advisory).getAllByRole('listitem')).toHaveLength(2)
        expect(advisory).toHaveTextContent(/Every member would gain publish/)
    })

    it('says nothing when every role that changes data publishes it', () => {
        const { container } = render(<PublishGapAdvisory roles={ROLES.slice(2)} onChanged={vi.fn()} />)
        expect(container).toBeEmptyDOMElement()
    })

    it('gain publish one at a time, after the preview of who gains it', async () => {
        const onChanged = vi.fn()
        render(<PublishGapAdvisory roles={ROLES} onChanged={onChanged} />)
        await userEvent.click(screen.getByRole('button', { name: 'Add publish to pipeline_ops' }))
        expect(permissionsService.previewRoleUpdate).toHaveBeenCalledWith(
            'pipeline_ops', ['workspace:datasource:read', MANAGE, PUBLISH])
        expect(permissionsService.updateRole).not.toHaveBeenCalled()

        const confirm = await screen.findByRole('button', { name: /^add publish$/i })
        await waitFor(() => expect(confirm).toBeEnabled())
        await userEvent.click(confirm)
        await waitFor(() => expect(permissionsService.updateRole).toHaveBeenCalledWith('pipeline_ops', {
            description: null, permissions: ['workspace:datasource:read', MANAGE, PUBLISH],
        }))
        expect(onChanged).toHaveBeenCalled()
    })
})
