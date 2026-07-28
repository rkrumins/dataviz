/**
 * Creating an access rule.
 *
 * Three things the grid-of-selects form got wrong, each of which is a
 * failure the operator only found out about from the server:
 *
 *   * It asked for `ws_xxxxxxxx` and `grp_xxxxxxxx` by hand. Nothing in
 *     this product displays a workspace id, so the field was unanswerable
 *     without a database.
 *   * It offered a Scope picker that could contradict the chosen role, and
 *     400ed when it did.
 *   * It let you submit an incomplete rule and reported the gap afterwards.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IdpProvider } from '@/services/ssoAdminService'

const { createRoleBindingMapping, createGroupMembershipMapping,
        listRoles, listWorkspaces, listGroups } = vi.hoisted(() => ({
    createRoleBindingMapping: vi.fn(),
    createGroupMembershipMapping: vi.fn(),
    listRoles: vi.fn(),
    listWorkspaces: vi.fn(),
    listGroups: vi.fn(),
}))

vi.mock('@/services/ssoAdminService', async () => {
    const a = await vi.importActual<typeof import('@/services/ssoAdminService')>(
        '@/services/ssoAdminService')
    return {
        ...a,
        ssoAdminService: {
            ...a.ssoAdminService, createRoleBindingMapping, createGroupMembershipMapping,
        },
    }
})
vi.mock('@/services/permissionsService', () => ({
    permissionsService: { listRoles },
}))
vi.mock('@/services/workspaceService', () => ({
    workspaceService: { list: listWorkspaces },
}))
vi.mock('@/services/groupsService', () => ({
    groupsService: { list: listGroups },
}))

import { MappingComposer } from '../MappingComposer'

const ROLES = [
    {
        name: 'org_member', isSystem: true, scopeType: 'global',
        permissions: ['catalog:read'], description: 'Read the catalogue.',
    },
    {
        name: 'workspace_editor', isSystem: true, scopeType: 'workspace',
        permissions: ['workspace:write'], description: 'Edit one workspace.',
    },
]

const PROVIDERS = [{
    id: 'idp_1', slug: 'entra', displayName: 'Corporate Entra',
} as IdpProvider]

function renderComposer() {
    const onCreated = vi.fn()
    const onError = vi.fn()
    render(<MappingComposer providers={PROVIDERS}
                            onCreated={onCreated} onError={onError} />)
    return { onCreated, onError }
}

beforeEach(() => {
    vi.clearAllMocks()
    listRoles.mockResolvedValue(ROLES)
    listWorkspaces.mockResolvedValue([
        { id: 'ws_abc', name: 'Analytics' }, { id: 'ws_def', name: 'Finance' },
    ])
    listGroups.mockResolvedValue([
        { id: 'grp_1', name: 'Data stewards', memberCount: 4 },
    ])
    createRoleBindingMapping.mockResolvedValue({})
    createGroupMembershipMapping.mockResolvedValue({})
})

describe('ids became pickers', () => {
    it('offers workspaces by name instead of asking for an id', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')

        const picker = await screen.findByLabelText('Workspace')
        expect(within(picker).getByText('Analytics')).toBeInTheDocument()
        // The thing nobody could answer.
        expect(screen.queryByPlaceholderText(/ws_/)).toBeNull()
    })

    it('offers internal groups by name instead of asking for an id', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listGroups).toHaveBeenCalled())

        await user.selectOptions(screen.getByLabelText('What they get'),
                                 'group_membership')

        expect(await screen.findByText(/Data stewards/)).toBeInTheDocument()
        expect(screen.queryByPlaceholderText(/grp_/)).toBeNull()
    })
})

describe('scope is implied, never asked', () => {
    it('asks for a workspace only when the role needs one', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')
        expect(screen.queryByLabelText('Workspace')).toBeNull()
        expect(screen.getByText(/across the whole organization/i)).toBeInTheDocument()

        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')
        expect(await screen.findByLabelText('Workspace')).toBeInTheDocument()
    })

    it('sends the scope the role actually requires', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')
        await user.selectOptions(await screen.findByLabelText('Workspace'), 'ws_abc')
        await user.click(screen.getByRole('button', { name: /create rule/i }))

        await waitFor(() => expect(createRoleBindingMapping).toHaveBeenCalledWith({
            providerId: null, idpGroup: 'engineering', roleName: 'workspace_editor',
            scopeType: 'workspace', scopeId: 'ws_abc',
        }))
    })

    it('sends global scope with no id for an organization role', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'staff')
        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')
        await user.click(screen.getByRole('button', { name: /create rule/i }))

        await waitFor(() => expect(createRoleBindingMapping).toHaveBeenCalledWith(
            expect.objectContaining({ scopeType: 'global', scopeId: null }),
        ))
    })
})

describe('incomplete rules cannot be submitted', () => {
    it('refuses until the group and role are both chosen', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())
        const submit = screen.getByRole('button', { name: /create rule/i })
        expect(submit).toBeDisabled()

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        expect(submit).toBeDisabled()

        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')
        expect(submit).toBeEnabled()
    })

    it('refuses a workspace role until a workspace is picked', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')

        expect(screen.getByRole('button', { name: /create rule/i })).toBeDisabled()
        await user.selectOptions(await screen.findByLabelText('Workspace'), 'ws_def')
        expect(screen.getByRole('button', { name: /create rule/i })).toBeEnabled()
    })
})

describe('the preview line', () => {
    // The sentence used to be the layout, with live selects inside running
    // prose that wrapped mid-phrase. It is now a preview underneath, which
    // lets it do the job it is actually good at: stating what will be
    // written, with every id resolved to the name it was picked by.
    it('resolves the workspace to its name, not its id', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')
        await user.selectOptions(await screen.findByLabelText('Workspace'), 'ws_abc')

        expect(await screen.findByText(/anyone in engineering gets .* in Analytics\./i))
            .toBeInTheDocument()
        expect(screen.queryByText(/ws_abc/)).toBeNull()
    })

    it('names the connection when the rule is scoped to one', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'staff')
        await user.selectOptions(screen.getByLabelText('Provider'), 'idp_1')
        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')

        expect(await screen.findByText(/from Corporate Entra/i)).toBeInTheDocument()
    })

    it('says what is still missing rather than going blank', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')

        // Anchored to the preview's sentence: "choose a workspace…" is also
        // the picker's own placeholder option.
        expect(await screen.findByText(/anyone in engineering gets .*choose a workspace/i))
            .toBeInTheDocument()
    })
})

describe('the privileged-role floor', () => {
    it('never offers a role the backend refuses to auto-grant', async () => {
        listRoles.mockResolvedValue([
            ...ROLES,
            { name: 'super_admin', isSystem: true, scopeType: 'global',
              permissions: ['system:admin'], description: 'Everything.' },
        ])
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        // FORBIDDEN_AUTO_GRANT_ROLES is enforced server-side too; offering
        // it here would be a form that exists only to be rejected.
        await waitFor(() => {
            expect(within(screen.getByLabelText('Role'))
                .queryByText(/super.admin/i)).toBeNull()
        })
    })
})
