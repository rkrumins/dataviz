/**
 * Removing an access rule is a change to who can do what, and it used to
 * be silent: the card vanished, and that was the whole report.
 *
 * A vanished row is ambiguous — it looks the same whether the delete
 * landed or the list merely re-read — so the outcome now goes to the
 * app's one notification stack, naming the directory group whose members
 * lose the access and saying when they lose it. The tab's error banner
 * keeps only what is still true while it is being read: a list of rules
 * that could not be loaded at all.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MappingsTab } from '../MappingsTab'
import {
    NotificationStack, useNotificationStore,
} from '@/components/ui/notifications'
import { ssoAdminService, type IdpGroupMapping } from '@/services/ssoAdminService'

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: {
        listGroupMappings: vi.fn(),
        listProviders: vi.fn(),
        deleteMapping: vi.fn(),
    },
}))
vi.mock('@/services/workspaceService', () => ({
    workspaceService: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/services/groupsService', () => ({
    groupsService: { list: vi.fn().mockResolvedValue([]) },
}))
// Makes its own service calls and reports its own outcome; it has its
// own tests.
vi.mock('../mappings/MappingComposer', () => ({
    MappingComposer: () => null,
}))
// The card's rendering has its own tests; here it only needs to hand the
// delete back to the tab.
vi.mock('../mappings/MappingGroupCard', async () => {
    const actual = await vi.importActual<
        typeof import('../mappings/MappingGroupCard')
    >('../mappings/MappingGroupCard')
    return {
        groupMappings: actual.groupMappings,
        MappingGroupCard: ({ group, onDelete }: {
            group: { idpGroup: string; rows: { id: string }[] }
            onDelete: (id: string) => void
        }) => (
            <button onClick={() => onDelete(group.rows[0].id)}>
                delete {group.idpGroup}
            </button>
        ),
    }
})

const svc = ssoAdminService as unknown as Record<string, ReturnType<typeof vi.fn>>
const raised = () => useNotificationStore.getState().notifications

const RULE = {
    id: 'map_1', providerId: null, idpGroup: 'engineering',
    targetType: 'role_binding', roleName: 'org_member',
    scopeType: 'global', scopeId: null, targetGroupId: null,
} as IdpGroupMapping

beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    svc.listGroupMappings.mockResolvedValue([RULE])
    svc.listProviders.mockResolvedValue([])
    svc.deleteMapping.mockResolvedValue(undefined)
})

function page() {
    render(<><MappingsTab /><NotificationStack /></>)
}

describe('removing a rule', () => {
    it('names the group that loses the access, and when', async () => {
        const user = userEvent.setup()
        page()

        await user.click(await screen.findByRole('button', {
            name: 'delete engineering',
        }))

        await waitFor(() => expect(svc.deleteMapping).toHaveBeenCalledWith('map_1'))
        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('success')
        expect(raised()[0].message).toBe(
            'Rule removed — anyone in “engineering” stops getting it as '
            + 'their sessions refresh.',
        )
    })

    it('names the rule when the delete is refused with no message', async () => {
        svc.deleteMapping.mockRejectedValueOnce(new Error(''))
        const user = userEvent.setup()
        page()

        await user.click(await screen.findByRole('button', {
            name: 'delete engineering',
        }))

        await waitFor(() => expect(raised()).toHaveLength(1))
        expect(raised()[0].type).toBe('error')
        expect(raised()[0].message)
            .toBe('Could not remove the rule for “engineering”.')
    })
})

describe('the banner underneath', () => {
    it('keeps the one thing still true while it is read: an unreadable list', async () => {
        svc.listGroupMappings.mockRejectedValue(new Error('the directory is down'))
        page()

        expect(await screen.findByText(/the directory is down/i))
            .toBeInTheDocument()
        // …and it did not also pop up. A failed read is state, not news.
        expect(raised()).toHaveLength(0)
    })

    it('never renders an empty box when the failure carried no words', async () => {
        svc.listGroupMappings.mockRejectedValue(new Error(''))
        page()

        expect(await screen.findByText(/access rules could not be read/i))
            .toBeInTheDocument()
    })
})
