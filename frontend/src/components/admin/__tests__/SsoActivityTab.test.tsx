/**
 * A row in the sign-in activity log opens onto what was recorded: who it
 * concerned, the detail behind the reason, and where the attempt came from.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store/auth', async () => {
    const actual = await vi.importActual<typeof import('@/store/auth')>('@/store/auth')
    return { ...actual, usePermission: () => true }
})

const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/services/auditService', () => ({ auditService: { list } }))

import { SsoActivityTab } from '../SsoActivityTab'

describe('an activity row', () => {
    it('opens onto the person, the detail and the origin', async () => {
        list.mockResolvedValue({
            nextCursor: null,
            events: [{
                eventId: 'evt_1', eventType: 'user.sso_login_failed',
                eventVersion: 1, createdAt: '2026-09-29T09:00:00+00:00',
                severity: 'warning',
                summary: '[ab12cd34] Sign-in via corp failed for Ada: backchannel_unavailable',
                targetUserId: 'usr_ada', targetUserName: 'Ada',
                targetUserEmail: 'ada@corp.io',
                payload: {
                    ref: 'ab12cd34', reason: 'backchannel_unavailable',
                    detail: 'idp_status:503', client_ip: '10.1.2.3',
                    user_agent: 'DiagBrowser/1.0',
                    path: '/api/v1/auth/corp/backchannel',
                },
            }],
        })
        const user = userEvent.setup()
        render(<SsoActivityTab />)

        await user.click(await screen.findByRole('button', { name: /show details/i }))

        expect(screen.getByText('idp_status:503')).toBeInTheDocument()
        expect(screen.getByText('10.1.2.3')).toBeInTheDocument()
        expect(screen.getByText('DiagBrowser/1.0')).toBeInTheDocument()
        expect(screen.getByText(/ada@corp\.io/)).toBeInTheDocument()
        expect(screen.getByText(/raw event payload/i)).toBeInTheDocument()
    })
})
