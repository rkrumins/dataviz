/**
 * The SSO activity table: fields as columns, every filter on the server,
 * and a row that opens onto the whole record.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActivityPage, ActivityRow } from '@/services/ssoAdminService'

vi.mock('@/store/auth', async () => {
    const actual = await vi.importActual<typeof import('@/store/auth')>('@/store/auth')
    return { ...actual, usePermission: () => true }
})

const { activity } = vi.hoisted(() => ({ activity: vi.fn() }))
vi.mock('@/services/ssoAdminService', () => ({ ssoAdminService: { activity } }))

import { SsoActivityTab } from '../SsoActivityTab'

function row(over: Partial<ActivityRow> = {}): ActivityRow {
    return {
        id: 'evt_1', at: '2026-09-29T09:00:00+00:00',
        eventType: 'user.sso_login_failed', outcome: 'failed',
        severity: 'warning',
        summary: '[ab12cd34] Sign-in via corp failed for Ada: backchannel_unavailable',
        person: { userId: 'usr_ada', name: 'Ada Lovelace', email: 'ada@corp.io', deleted: false },
        connection: { slug: 'corp', name: 'Corporate' },
        reason: 'backchannel_unavailable', detail: 'idp_status:503',
        ref: 'ab12cd34', clientIp: '10.1.2.3',
        userAgent: 'Mozilla/5.0 Chrome/129.0.0.0',
        payload: { ref: 'ab12cd34', client_ip: '10.1.2.3', path: '/api/v1/auth/corp/backchannel' },
        ...over,
    }
}

function page(over: Partial<ActivityPage> = {}): ActivityPage {
    return {
        rows: [
            row(),
            row({
                id: 'evt_2', eventType: 'user.logged_in', outcome: 'signed_in',
                severity: 'info', summary: 'Signed in via corp', reason: null,
                detail: null, ref: null, clientIp: null, userAgent: null,
            }),
        ],
        nextCursor: 'c1',
        counts: {
            signed_in: 120, failed: 7, session_ended: 3, signed_out: 40,
            account: 0, trust: 0, config: 1,
        },
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    activity.mockResolvedValue(page())
})

describe('the table', () => {
    it('puts who, via, outcome, reason, reference and origin in columns', async () => {
        render(<SsoActivityTab />)
        const failed = (await screen.findAllByText('Ada Lovelace'))[0].closest('tr')!

        for (const text of ['Corporate', 'Failed', 'backchannel_unavailable', 'idp_status:503', '10.1.2.3']) {
            expect(within(failed).getByText(text)).toBeInTheDocument()
        }
        expect(within(failed).getByTitle('Copy the reference')).toHaveTextContent('ab12cd34')
        // A sign-in has no reference; the column says so rather than lying.
        const signedIn = screen.getByText('Signed in').closest('tr')!
        expect(within(signedIn).getAllByText('—').length).toBeGreaterThan(0)
    })

    it('counts every outcome and says how many are shown', async () => {
        render(<SsoActivityTab />)
        const chips = await screen.findByRole('group', { name: /filter by outcome/i })
        expect(within(chips).getByRole('button', { name: /Failures\s*7/ })).toBeInTheDocument()
        expect(within(chips).getByRole('button', { name: /Everything\s*171/ })).toBeInTheDocument()
        expect(screen.getByText(/showing 2 of 171/i)).toBeInTheDocument()
    })

    it('opens a row onto the whole record', async () => {
        const user = userEvent.setup()
        render(<SsoActivityTab />)
        const failed = (await screen.findAllByText('Ada Lovelace'))[0].closest('tr')!
        await user.click(within(failed).getByRole('button', { name: /show details/i }))

        expect(screen.getByText('/api/v1/auth/corp/backchannel')).toBeInTheDocument()
        expect(screen.getByText(/raw event payload/i)).toBeInTheDocument()
        expect(screen.getByText(/could not reach the sign-in gateway/i)).toBeInTheDocument()
    })
})

describe('filters run on the server', () => {
    it('by outcome', async () => {
        const user = userEvent.setup()
        render(<SsoActivityTab />)
        const chips = await screen.findByRole('group', { name: /filter by outcome/i })
        await user.click(within(chips).getByRole('button', { name: /Failures/ }))
        await waitFor(() => expect(activity).toHaveBeenLastCalledWith(
            expect.objectContaining({ outcome: 'failed' }),
        ))
    })

    it('by a search once typing settles', async () => {
        const user = userEvent.setup()
        render(<SsoActivityTab />)
        await screen.findAllByText('Ada Lovelace')
        await user.type(screen.getByLabelText(/search activity/i), 'ab12cd34')
        await waitFor(() => expect(activity).toHaveBeenLastCalledWith(
            expect.objectContaining({ q: 'ab12cd34' }),
        ))
    })

    it('by clicking a person or a connection in the table', async () => {
        const user = userEvent.setup()
        render(<SsoActivityTab />)
        const failed = (await screen.findAllByText('Ada Lovelace'))[0].closest('tr')!

        await user.click(within(failed).getByTitle('Show only this connection'))
        await waitFor(() => expect(activity).toHaveBeenLastCalledWith(
            expect.objectContaining({ connection: 'corp' }),
        ))
        await user.click(within(failed).getByTitle('Show only this person'))
        await waitFor(() => expect(activity).toHaveBeenLastCalledWith(
            expect.objectContaining({ q: 'ada@corp.io' }),
        ))
    })

    it('opens with a quoted reference already searched', async () => {
        render(<SsoActivityTab initialQuery="ab12cd34" />)
        await waitFor(() => expect(activity).toHaveBeenCalledWith(
            expect.objectContaining({ q: 'ab12cd34' }),
        ))
    })

    it('continues from the cursor', async () => {
        const user = userEvent.setup()
        activity
            .mockResolvedValueOnce(page())
            .mockResolvedValueOnce(page({
                rows: [row({ id: 'evt_3', ref: 'ffee0011' })], nextCursor: null,
            }))
        render(<SsoActivityTab />)
        await user.click(await screen.findByRole('button', { name: /load more/i }))

        await waitFor(() => expect(activity).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: 'c1' }),
        ))
        expect(await screen.findByText('ffee0011')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument()
    })
})
