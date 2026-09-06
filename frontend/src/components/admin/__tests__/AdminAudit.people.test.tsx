/**
 * The audit log names the people in it.
 *
 * Actor and Target rendered `event.actorId` — a bare `usr_ac3f19`-shaped
 * string — as a monospace link, and the expanded row was a raw
 * `JSON.stringify` of the payload. An administrator asked "which user was
 * affected by this" had to open a tab per row to find out, and the four facts
 * they actually needed were buried in a JSON blob under keys that differ per
 * event type.
 *
 * The rule that runs through all of these: SHOW THE PERSON, KEEP THE ID, AND
 * NEVER INVENT EITHER. A resolved user gets their name and email with the id
 * moved into further details; an id the server could not resolve stays a bare
 * id, because a system event or a hard-deleted row is a real state and
 * "Unknown user" would claim a fact nobody has.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/auditService', () => ({
    auditService: { list: vi.fn(), listEventTypes: vi.fn() },
}))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify: vi.fn(), error: vi.fn(), success: vi.fn() }),
}))

import { AdminAudit } from '../AdminAudit'
import { auditService, type AuditEvent } from '@/services/auditService'

const list = vi.mocked(auditService.list)
const listEventTypes = vi.mocked(auditService.listEventTypes)

function event(over: Partial<AuditEvent> = {}): AuditEvent {
    return {
        eventId: 'evt_1',
        eventType: 'rbac.role.updated',
        eventVersion: 1,
        createdAt: new Date().toISOString(),
        severity: 'info',
        summary: 'Role changed',
        payload: { role: 'admin' },
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    listEventTypes.mockResolvedValue([])
    list.mockResolvedValue({ events: [event()], nextCursor: null })
})

describe('the audit log names people', () => {
    it('shows the full name and email, not the identifier', async () => {
        list.mockResolvedValue({
            events: [event({
                actorId: 'usr_admin1', actorName: 'Ada Lovelace',
                actorEmail: 'ada@example.com',
                targetUserId: 'usr_ac3f19', targetUserName: 'John Doe',
                targetUserEmail: 'john.doe@example.com',
            })],
            nextCursor: null,
        })
        render(<AdminAudit />)

        expect(await screen.findByText('John Doe')).toBeInTheDocument()
        expect(screen.getByText('john.doe@example.com')).toBeInTheDocument()
        expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
        // The id is off the face of the row — it lives in further details now.
        expect(screen.queryByText('usr_ac3f19')).not.toBeInTheDocument()
    })

    it('keeps the raw id when the server could not resolve it', async () => {
        // A system-generated event, or an account permanently removed. The id
        // is the record; inventing a name over it would be a lie.
        list.mockResolvedValue({
            events: [event({ actorId: 'usr_never_existed' })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        expect(await screen.findByText('usr_never_existed')).toBeInTheDocument()
        expect(screen.queryByText(/unknown user/i)).not.toBeInTheDocument()
    })

    it('still names a deleted account, and says that it is gone', async () => {
        // An audit log's most valuable row is often about an account that no
        // longer exists — "who was that, and what did they do first".
        list.mockResolvedValue({
            events: [event({
                targetUserId: 'usr_gone', targetUserName: 'Grace Hopper',
                targetUserEmail: 'grace@example.com', targetUserDeleted: true,
            })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        expect(await screen.findByText('Grace Hopper')).toBeInTheDocument()
        expect(screen.getByText('Deleted')).toBeInTheDocument()
    })

    it('hands the identifiers back in further details, ready to copy', async () => {
        list.mockResolvedValue({
            events: [event({
                actorId: 'usr_admin1', actorName: 'Ada Lovelace',
                actorEmail: 'ada@example.com',
                targetUserId: 'usr_ac3f19', targetUserName: 'John Doe',
                targetUserEmail: 'john.doe@example.com',
                workspaceId: 'ws_7',
            })],
            nextCursor: null,
        })
        const u = userEvent.setup()
        render(<AdminAudit />)
        // The row expands; the PERSON does not, because that cell is a link to
        // the user list and stops the click. Open it by its summary.
        await u.click(await screen.findByText('Role changed'))

        await waitFor(() => expect(screen.getByText('Target user id')).toBeInTheDocument())
        expect(screen.getByText('usr_ac3f19')).toBeInTheDocument()
        expect(screen.getByText('usr_admin1')).toBeInTheDocument()
        // Twice, deliberately: the row's Workspace column still shows the id
        // (workspaces are not resolved to names yet) and the panel repeats it
        // as a copyable field.
        expect(screen.getAllByText('ws_7').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByRole('button', { name: 'Copy Target user id' })).toBeInTheDocument()
    })

    it('keeps the raw payload available, one disclosure down', async () => {
        // Structuring the four facts an operator needs must not throw away the
        // blob — the summary is not always enough.
        const u = userEvent.setup()
        list.mockResolvedValue({
            events: [event({ targetUserId: 'usr_x', payload: { role: 'admin', extra: 'kept' } })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        await u.click(await screen.findByText('Role changed'))
        expect(await screen.findByText('Raw event payload')).toBeInTheDocument()
        expect(screen.getByText(/"extra": "kept"/)).toBeInTheDocument()
    })

    it('links a person to THEIR DETAILS, not to a list to search', async () => {
        // The round trip: the log names the person, and the link opens that
        // person's access drawer on /admin/users — a filtered list would still
        // leave the reader a click away from the answer.
        list.mockResolvedValue({
            events: [event({
                targetUserId: 'usr_ac3f19', targetUserName: 'John Doe',
                targetUserEmail: 'john.doe@example.com',
            })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        const link = (await screen.findByText('John Doe')).closest('a')
        expect(link).toHaveAttribute('href', '/admin/users?user=usr_ac3f19')
    })

    it('shows an em dash for an event that genuinely has no actor', async () => {
        list.mockResolvedValue({ events: [event({ actorId: null })], nextCursor: null })
        render(<AdminAudit />)
        await screen.findByText('Role changed')
        expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    })

    it('names the workspace instead of printing its id', async () => {
        list.mockResolvedValue({
            events: [event({ workspaceId: 'ws_4f21c8', workspaceName: 'Data Platform' })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        expect(await screen.findByText('Data Platform')).toBeInTheDocument()
        expect(screen.queryByText('ws_4f21c8')).not.toBeInTheDocument()
    })

    it('keeps the workspace id when it resolves to nothing', async () => {
        // A permanently removed workspace. Same rule as people: the id is the
        // record, and a name must never be invented over it.
        list.mockResolvedValue({
            events: [event({ workspaceId: 'ws_gone' })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        expect(await screen.findByText('ws_gone')).toBeInTheDocument()
    })

    it('asks for a person, not only an identifier', async () => {
        // The boxes asked for a user id back when the table showed nothing
        // else. Now that it names people, typing one and getting an empty log
        // reads as "this person did nothing" rather than "that is not an id".
        render(<AdminAudit />)
        await screen.findByText('Role changed')
        expect(screen.getByLabelText('Filter by who it affected'))
            .toHaveAttribute('placeholder', expect.stringMatching(/name, email or user ID/i))
        expect(screen.getByLabelText('Filter by who did it')).toBeInTheDocument()
    })

    it('sends the typed term through as the filter, whatever shape it is', async () => {
        const u = userEvent.setup()
        render(<AdminAudit />)
        await screen.findByText('Role changed')
        await u.type(screen.getByLabelText('Filter by who it affected'), 'john')
        await waitFor(() => expect(list).toHaveBeenCalledWith(
            expect.objectContaining({ targetUserId: 'john' }),
        ))
    })
})

describe('everything else the event mentions gets named too', () => {
    it('shows name-and-id chips for resolved references in further details', async () => {
        const u = userEvent.setup()
        list.mockResolvedValue({
            events: [event({
                summary: "User added to group 'Use Case A'",
                payload: { group_id: 'grp_ab12', provider_id: 'idp_cd34' },
                resolvedNames: {
                    grp_ab12: 'Use Case A',
                    idp_cd34: 'Corp AD',
                },
            })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        await u.click(await screen.findByText(/added to group/))

        await waitFor(() =>
            expect(screen.getByText('Named in this event')).toBeInTheDocument())
        // Name beside id — the id stays the record, the name reads.
        expect(screen.getByText('Use Case A')).toBeInTheDocument()
        expect(screen.getByText('grp_ab12')).toBeInTheDocument()
        expect(screen.getByText('Corp AD')).toBeInTheDocument()
        expect(screen.getByText('idp_cd34')).toBeInTheDocument()
    })

    it('shows no key at all when nothing resolved', async () => {
        const u = userEvent.setup()
        list.mockResolvedValue({
            events: [event({
                payload: { group_id: 'grp_gonehard' },
                resolvedNames: {},
            })],
            nextCursor: null,
        })
        render(<AdminAudit />)
        await u.click(await screen.findByText('Role changed'))

        await waitFor(() =>
            expect(screen.getByText('Raw event payload')).toBeInTheDocument())
        expect(screen.queryByText('Named in this event')).not.toBeInTheDocument()
    })
})
