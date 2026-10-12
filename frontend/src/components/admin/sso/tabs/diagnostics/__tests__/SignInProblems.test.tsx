/**
 * The per-person failure list: who, why, whether they have got in since —
 * and a row that opens onto what was recorded about each attempt.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FailureDigest, PersonFailures } from '@/services/ssoAdminService'

const { failureDigest } = vi.hoisted(() => ({ failureDigest: vi.fn() }))

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: { failureDigest },
}))

import { SignInProblems } from '../SignInProblems'

function person(over: Partial<PersonFailures> = {}): PersonFailures {
    return {
        key: 'usr_ada', kind: 'account', userId: 'usr_ada',
        email: 'ada@corp.io', name: 'Ada Lovelace', status: 'active',
        deleted: false, passwordSet: false,
        waysIn: [{ slug: 'corp', name: 'Corporate', lastUsedAt: null }],
        lastSignInAt: '2026-09-01T00:00:00+00:00',
        attempts: 4,
        firstAt: '2026-09-29T08:00:00+00:00',
        lastAt: '2026-09-29T09:00:00+00:00',
        stillFailing: true,
        latest: {
            code: 'no_local_password', provider: 'password',
            providerName: null, detail: null, ref: null,
        },
        reasons: [
            { code: 'no_local_password', count: 3 },
            { code: 'backchannel_unavailable', count: 1 },
        ],
        clients: 1,
        sessionEnds: [{
            at: '2026-09-29T07:00:00+00:00', eventType: 'user.session_refused',
            reason: 'reuse_detected', provider: null,
        }],
        recent: [
            {
                at: '2026-09-29T09:00:00+00:00', code: 'no_local_password',
                provider: 'password', clientIp: '10.1.2.3',
                userAgent: 'Mozilla/5.0 Chrome/129.0.0.0',
            },
            {
                at: '2026-09-29T08:00:00+00:00', code: 'backchannel_unavailable',
                provider: 'corp', detail: 'idp_status:503', ref: 'ab12cd34',
                clientIp: '10.1.2.3',
            },
        ],
        related: [],
        ...over,
    }
}

function digest(over: Partial<FailureDigest> = {}): FailureDigest {
    return {
        window: { from: '', scanned: 5, truncated: false },
        totals: { attempts: 5, people: 1, stillFailing: 1, unidentified: 1 },
        reasons: [
            { code: 'no_local_password', count: 3 },
            { code: 'backchannel_unavailable', count: 2 },
        ],
        providers: [
            { slug: 'password', name: null, count: 3 },
            { slug: 'corp', name: 'Corporate', count: 2 },
        ],
        people: [
            person(),
            person({
                key: 'unidentified:corp', kind: 'unidentified', userId: null,
                email: null, name: null, stillFailing: null, attempts: 1,
                clients: 2, waysIn: [], sessionEnds: [],
                latest: {
                    code: 'backchannel_no_session', provider: 'corp',
                    providerName: 'Corporate',
                },
            }),
        ],
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    failureDigest.mockResolvedValue(digest())
})

describe('the list', () => {
    it('leads with totals and names each person, and why', async () => {
        render(<SignInProblems />)

        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument()
        expect(screen.getByText('Unidentified browsers')).toBeInTheDocument()
        expect(screen.getByText('People affected')).toBeInTheDocument()
        const row = screen.getByText('Ada Lovelace').closest('tr')!
        expect(within(row).getByText('Still failing')).toBeInTheDocument()
        // The code, and the code in words.
        expect(within(row).getByText('no_local_password')).toBeInTheDocument()
        expect(within(row).getByText(/has no password/i)).toBeInTheDocument()
    })

    it('filters by reason on the server', async () => {
        const user = userEvent.setup()
        render(<SignInProblems />)
        await screen.findByText('Ada Lovelace')

        const chips = screen.getByRole('group', { name: /filter by reason/i })
        await user.click(within(chips).getByRole('button', { name: /backchannel_unavailable/ }))

        await waitFor(() => expect(failureDigest).toHaveBeenLastCalledWith(
            expect.objectContaining({ reason: 'backchannel_unavailable' }),
        ))
    })

    it('searches for a person on the server once typing settles', async () => {
        const user = userEvent.setup()
        render(<SignInProblems />)
        await screen.findByText('Ada Lovelace')

        await user.type(screen.getByLabelText(/find a person/i), 'ada')

        await waitFor(() => expect(failureDigest).toHaveBeenLastCalledWith(
            expect.objectContaining({ q: 'ada' }),
        ))
    })

    it('says when the window held more than it read', async () => {
        failureDigest.mockResolvedValue(digest({
            window: { from: '', scanned: 5000, truncated: true },
        }))
        render(<SignInProblems />)
        expect(await screen.findByText(/most recent 5,000 records/i)).toBeInTheDocument()
    })

    it('says so when nobody failed', async () => {
        failureDigest.mockResolvedValue(digest({
            people: [], reasons: [], providers: [],
            totals: { attempts: 0, people: 0, stillFailing: 0, unidentified: 0 },
        }))
        render(<SignInProblems />)
        expect(await screen.findByText(/no failed sign-ins in this window/i))
            .toBeInTheDocument()
    })
})

describe('a person', () => {
    it('opens onto the account, the reasons, and every attempt', async () => {
        const user = userEvent.setup()
        render(<SignInProblems />)
        await user.click(await screen.findByRole('button', {
            name: /show details for ada lovelace/i,
        }))

        expect(screen.getByText(/signs in only through corporate/i)).toBeInTheDocument()
        expect(screen.getByText('idp_status:503')).toBeInTheDocument()
        expect(screen.getByText('ab12cd34')).toBeInTheDocument()
        expect(screen.getAllByText(/10\.1\.2\.3/).length).toBeGreaterThan(0)
        expect(screen.getByText('reuse_detected')).toBeInTheDocument()
        expect(screen.getByText(/session ended before this/i)).toBeInTheDocument()
    })

    it('shows the unnamed failure that came just before, from the same browser', async () => {
        failureDigest.mockResolvedValue(digest({
            people: [person({
                related: [{
                    at: '2026-09-29T08:59:00+00:00', code: 'backchannel_unavailable',
                    provider: 'corp', detail: 'idp_status:503', ref: 'ff00ee11',
                    clientIp: '10.1.2.3',
                }],
            })],
        }))
        const user = userEvent.setup()
        render(<SignInProblems />)
        const row = (await screen.findByText('Ada Lovelace')).closest('tr')!
        expect(within(row).getByText(/from the same browser/i)).toBeInTheDocument()

        await user.click(within(row).getByRole('button', { name: /show details/i }))
        expect(screen.getByText(/just before, from the same browser/i)).toBeInTheDocument()
        expect(screen.getByText(/ff00ee11/)).toBeInTheDocument()
    })

    it('hands the person to the account lookup', async () => {
        const user = userEvent.setup()
        const onInspect = vi.fn()
        render(<SignInProblems onInspect={onInspect} />)
        await user.click(await screen.findByRole('button', {
            name: /show details for ada lovelace/i,
        }))
        await user.click(screen.getByRole('button', { name: /open account/i }))
        expect(onInspect).toHaveBeenCalledWith('ada@corp.io')
    })
})
