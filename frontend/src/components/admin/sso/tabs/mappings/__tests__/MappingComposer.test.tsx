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
        updateGroupMapping, listRoles, listWorkspaces, listGroups,
} = vi.hoisted(() => ({
    createRoleBindingMapping: vi.fn(),
    createGroupMembershipMapping: vi.fn(),
    updateGroupMapping: vi.fn(),
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
            ...a.ssoAdminService, createRoleBindingMapping,
            createGroupMembershipMapping, updateGroupMapping,
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
import {
    NotificationStack, useNotificationStore,
} from '@/components/ui/notifications'

const ROLES = [
    {
        name: 'org_member', isSystem: true, scopeType: 'global',
        permissions: ['catalog:read'], description: 'Read the catalogue.',
    },
    {
        name: 'org_admin', isSystem: true, scopeType: 'global',
        permissions: ['system:admin'], description: 'Runs the organization.',
    },
    {
        name: 'workspace_editor', isSystem: true, scopeType: 'workspace',
        permissions: ['workspace:write'], description: 'Edit one workspace.',
    },
]

const PROVIDERS = [{
    id: 'idp_1', slug: 'entra', displayName: 'Corporate Entra',
} as IdpProvider]

/** The composer reports its own outcome, through the app's one
 *  notification stack — the tab's banner is for a list that would not
 *  load, not for a rule that would not save. */
const raised = () => useNotificationStore.getState().notifications

function renderComposer() {
    const onCreated = vi.fn()
    render(<>
        <MappingComposer providers={PROVIDERS} onCreated={onCreated} />
        <NotificationStack />
    </>)
    return { onCreated }
}

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
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

describe('the rule takes shape as you fill it', () => {
    // Four identical-looking controls give no sense of progress. The count
    // and the settled-slot marker are the feedback that the rule is going
    // somewhere.
    it('counts what is still to choose, and stops when ready', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())
        expect(screen.getByText(/0 of 2 chosen/i)).toBeInTheDocument()

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        expect(screen.getByText(/1 of 2 chosen/i)).toBeInTheDocument()

        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')
        expect(screen.getByText(/ready/i)).toBeInTheDocument()
    })

    it('asks for a third answer once the role needs a workspace', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')
        expect(screen.getByText(/2 of 3 chosen/i)).toBeInTheDocument()
    })
})

describe('the preview is the row it will become', () => {
    // Rendered through `RuleTarget` — the same component the saved rule
    // uses — so "exactly what gets saved" is literal rather than a claim.
    // A second renderer would be free to drift from the first.
    it('shows the resolved role and workspace once complete', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')
        await user.selectOptions(await screen.findByLabelText('Workspace'), 'ws_abc')

        expect(await screen.findByText(/will be created as/i)).toBeInTheDocument()
        expect(screen.getByText('in Analytics')).toBeInTheDocument()
    })

    it('describes the rule in one voice while it is incomplete', async () => {
        // The sentence stands in for the row until there is a row. Saying
        // "choose a role" in a prompt *and* in the sentence would be two
        // voices telling the operator the same thing.
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        expect(screen.getAllByText(/anyone in engineering gets.*choose a role/i))
            .toHaveLength(1)
        expect(screen.queryByText(/will be created as/i)).toBeNull()
    })

    it('does not claim readiness while a privileged rule is blocked', async () => {
        // The pre-flight and the preview must agree: a rule the server would
        // refuse is not "will be created as".
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'admins')
        await user.selectOptions(screen.getByLabelText('Role'), 'org_admin')

        expect(screen.queryByText(/will be created as/i)).toBeNull()
    })
})

describe('saying what was saved', () => {
    // The preview sentence is already the plain-language statement of the
    // rule, with every id resolved to the name it was picked by. The
    // confirmation says the same thing rather than "Created" — which
    // would name nothing, on a page where two rules differ by one word.
    it('repeats the rule it just wrote, in the words of the preview', async () => {
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'engineering')
        await user.selectOptions(screen.getByLabelText('Role'), 'workspace_editor')
        await user.selectOptions(await screen.findByLabelText('Workspace'), 'ws_abc')
        await user.click(screen.getByRole('button', { name: /create rule/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message).toMatch(
            /^Rule created\. Anyone in engineering gets .* in Analytics\.$/,
        )
    })

    it('falls back to naming the act when the refusal carries no words', async () => {
        createRoleBindingMapping.mockRejectedValueOnce(new Error(''))
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'staff')
        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')
        await user.click(screen.getByRole('button', { name: /create rule/i }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('error')
        expect(raised()[0].message).toBe('Could not create the rule.')
    })

    it('passes the server its own words when it gave any', async () => {
        createRoleBindingMapping.mockRejectedValueOnce(
            new Error('That group already has this role.'),
        )
        const user = userEvent.setup()
        renderComposer()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), 'staff')
        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')
        await user.click(screen.getByRole('button', { name: /create rule/i }))

        expect(await screen.findByText(/already has this role/i))
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

describe('editing a live rule', () => {
    const RULE = {
        id: 'map_1', providerId: 'idp_1', idpGroup: 'group1',
        targetType: 'group_membership', roleName: null, scopeType: null,
        scopeId: null, targetGroupId: 'grp_1',
    } as import('@/services/ssoAdminService').IdpGroupMapping

    function renderEditor() {
        const onCreated = vi.fn()
        const onCancel = vi.fn()
        render(<>
            <MappingComposer
                providers={PROVIDERS}
                onCreated={onCreated}
                editing={RULE}
                onCancel={onCancel}
            />
            <NotificationStack />
        </>)
        return { onCreated, onCancel }
    }

    it('opens pre-filled, previews the current rule, and has nothing to save', async () => {
        renderEditor()
        await waitFor(() => expect(listGroups).toHaveBeenCalled())

        expect(screen.getByLabelText('IdP group name')).toHaveValue('group1')
        // The preview works from the first paint: the stored rule renders
        // through the same component the saved card uses.
        expect(screen.getByText('Will be saved as')).toBeInTheDocument()
        expect(screen.getByText('Unchanged')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /save changes/i }))
            .toBeDisabled()
        expect(screen.queryByText('Was:')).toBeNull()
    })

    it('a changed slot updates the preview, shows the was-line, and saves the whole rule', async () => {
        updateGroupMapping.mockResolvedValue({})
        const user = userEvent.setup()
        const { onCreated, onCancel } = renderEditor()
        await waitFor(() => expect(listGroups).toHaveBeenCalled())

        const input = screen.getByLabelText('IdP group name')
        await user.clear(input)
        await user.type(input, 'group2')

        expect(screen.getByText('Was:')).toBeInTheDocument()
        expect(screen.getByText('Ready')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /save changes/i }))

        await waitFor(() => expect(updateGroupMapping).toHaveBeenCalledWith(
            'map_1',
            {
                providerId: 'idp_1', idpGroup: 'group2',
                targetType: 'group_membership', roleName: null,
                scopeType: null, scopeId: null, targetGroupId: 'grp_1',
            },
        ))
        expect(onCreated).toHaveBeenCalled()
        expect(onCancel).toHaveBeenCalled()
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message).toMatch(/rule updated/i)
    })

    it('escape closes the editor without saving', async () => {
        const user = userEvent.setup()
        const { onCancel } = renderEditor()
        await waitFor(() => expect(listGroups).toHaveBeenCalled())

        await user.type(screen.getByLabelText('IdP group name'), '{Escape}')
        expect(onCancel).toHaveBeenCalled()
        expect(updateGroupMapping).not.toHaveBeenCalled()
    })

    it('can retarget across target types, scope implied as on create', async () => {
        updateGroupMapping.mockResolvedValue({})
        const user = userEvent.setup()
        renderEditor()
        await waitFor(() => expect(listRoles).toHaveBeenCalled())

        await user.selectOptions(
            screen.getByLabelText('What they get'), 'role_binding',
        )
        await user.selectOptions(screen.getByLabelText('Role'), 'org_member')
        await user.click(screen.getByRole('button', { name: /save changes/i }))

        await waitFor(() => expect(updateGroupMapping).toHaveBeenCalledWith(
            'map_1',
            expect.objectContaining({
                targetType: 'role_binding', roleName: 'org_member',
                scopeType: 'global', scopeId: null, targetGroupId: null,
            }),
        ))
    })
})
