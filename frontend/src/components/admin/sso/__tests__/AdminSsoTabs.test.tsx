/**
 * What the tab shell has to get right.
 *
 * Two things, and neither is cosmetic:
 *
 *   1. "Find user" is no longer a top-level tab — it is not SSO
 *      *configuration* — but the lookup itself still has to exist. It is the
 *      only surface in the app that resolves a person by claim attribute or
 *      IdP external id; Admin → Users filters an already-loaded list.
 *   2. The activity log is absent, not locked, without ``system:audit:read``.
 *      A locked panel advertises a capability the operator cannot use and
 *      cannot grant themselves.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const perms = { value: true }

vi.mock('@/store/auth', async () => {
    const actual = await vi.importActual<typeof import('@/store/auth')>('@/store/auth')
    return { ...actual, usePermission: () => perms.value }
})

const { listProviders, listGroupMappings, auditList, failureDigest, activity } = vi.hoisted(() => ({
    listProviders: vi.fn(),
    listGroupMappings: vi.fn(),
    auditList: vi.fn(),
    failureDigest: vi.fn(),
    activity: vi.fn(),
}))

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: {
        listProviders,
        listGroupMappings,
        failureDigest,
        activity,
        providerStatus: vi.fn().mockResolvedValue({ providers: [] }),
    },
}))

vi.mock('@/services/auditService', () => ({
    auditService: { list: auditList },
}))

import { DiagnosticsTab } from '../tabs/DiagnosticsTab'
import { AdminSso } from '../../AdminSso'

beforeEach(() => {
    vi.clearAllMocks()
    perms.value = true
    listProviders.mockResolvedValue([])
    listGroupMappings.mockResolvedValue([])
    auditList.mockResolvedValue({ events: [], nextCursor: null })
    failureDigest.mockResolvedValue(digest())
    activity.mockResolvedValue({
        rows: [], nextCursor: null,
        counts: {
            signed_in: 0, failed: 0, session_ended: 0, signed_out: 0,
            account: 0, trust: 0, config: 0,
        },
    })
})

function digest(attempts = 0) {
    return {
        window: { from: '', scanned: attempts, truncated: false },
        totals: { attempts, people: 0, stillFailing: 0, unidentified: 0 },
        reasons: [], providers: [], people: [],
    }
}

function provider(over: Record<string, unknown> = {}) {
    return {
        id: 'idp_1', slug: 'entra', displayName: 'Entra', kind: 'oidc',
        enabled: true, lifecycle: 'live', priority: 100, settings: {},
        claimMapping: {}, linkingPolicy: 'strict', assurance: 'verified',
        assuranceReason: '', emailDomains: [], createdAt: '', updatedAt: '',
        ...over,
    }
}

describe('tab shell', () => {
    it('offers five tabs and no longer a Find user tab', () => {
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        for (const name of [/^Providers$/, /Access mapping/, /Diagnostics/, /^Activity$/, /^Settings$/]) {
            expect(screen.getByRole('button', { name })).toBeInTheDocument()
        }
        expect(screen.queryByRole('button', { name: /find user/i })).not.toBeInTheDocument()
    })

    it('has no Activity tab without audit access', () => {
        perms.value = false
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        expect(screen.queryByRole('button', { name: /^Activity$/ })).not.toBeInTheDocument()
    })

    it('opens Activity with a quoted reference searched', async () => {
        const user = userEvent.setup()
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        await user.click(screen.getByRole('button', { name: /^Diagnostics$/ }))
        await user.type(screen.getByLabelText('Reference'), 'ab12cd34')
        await user.click(screen.getByRole('button', { name: /look up/i }))

        expect(screen.getByRole('button', { name: /^Activity$/ }))
            .toHaveAttribute('aria-current', 'page')
        expect(activity).toHaveBeenCalledWith(expect.objectContaining({ q: 'ab12cd34' }))
    })

    it('carries the page actions every other Admin section has', () => {
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        // Scoped to the page header: the first-run hero offers its own
        // "Connect a provider", which is a different affordance.
        const header = within(screen.getByRole('banner'))
        expect(header.getByRole('button', { name: /connect a provider/i }))
            .toBeInTheDocument()
        expect(header.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
})

describe('stat tiles', () => {
    it('counts live the way the sign-in page does', async () => {
        // enabled AND published, mirroring list_public_providers. Counting a
        // draft here would tell an operator a connection reaches people when
        // it reaches nobody — the confusion the lifecycle exists to prevent.
        listProviders.mockResolvedValue([
            provider({ id: 'a' }),
            provider({ id: 'b', lifecycle: 'draft' }),
            provider({ id: 'c', enabled: false }),
        ])
        render(<MemoryRouter><AdminSso /></MemoryRouter>)

        const live = await screen.findByText(/live connections/i)
        expect(within(live.closest('div')!.parentElement!).getByText('1'))
            .toBeInTheDocument()
        const drafts = screen.getByText(/drafts to rehearse/i)
        expect(within(drafts.closest('div')!.parentElement!).getByText('1'))
            .toBeInTheDocument()
    })

    it('leaves the failure count unknown without audit access', async () => {
        perms.value = false
        render(<MemoryRouter><AdminSso /></MemoryRouter>)

        const fails = await screen.findByText(/failed sign-ins/i)
        expect(within(fails.closest('div')!.parentElement!).getByText('—'))
            .toBeInTheDocument()
        expect(failureDigest).not.toHaveBeenCalled()
    })

    it('counts failed sign-in attempts, not every warning in the log', async () => {
        failureDigest.mockResolvedValue(digest(7))
        render(<MemoryRouter><AdminSso /></MemoryRouter>)

        const fails = await screen.findByText(/failed sign-ins/i)
        expect(await within(fails.closest('div')!.parentElement!).findByText('7'))
            .toBeInTheDocument()
        expect(auditList).not.toHaveBeenCalled()
    })
})

describe('stat tiles as navigation', () => {
    beforeEach(() => {
        listProviders.mockResolvedValue([
            provider({ id: 'a', slug: 'entra' }),
            provider({ id: 'b', slug: 'okta', lifecycle: 'draft' }),
        ])
    })

    it('narrows the connection list to the drafts it counted', async () => {
        const user = userEvent.setup()
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        await screen.findByText('entra')

        await user.click(screen.getByRole('button', { name: /drafts to rehearse/i }))

        expect(screen.getByText('okta')).toBeInTheDocument()
        expect(screen.queryByText('entra')).toBeNull()
        expect(screen.getByText(/showing drafts only/i)).toBeInTheDocument()
    })

    it('gives the filter back', async () => {
        const user = userEvent.setup()
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        await screen.findByText('entra')

        await user.click(screen.getByRole('button', { name: /drafts to rehearse/i }))
        await user.click(screen.getByRole('button', { name: /show all/i }))

        expect(screen.getByText('entra')).toBeInTheDocument()
    })

    it('does not leave the filter on when the tab is chosen by hand', async () => {
        // Coming back to Providers via the tab means the whole tab, not
        // whatever a tile last narrowed it to.
        const user = userEvent.setup()
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        await screen.findByText('entra')

        await user.click(screen.getByRole('button', { name: /drafts to rehearse/i }))
        await user.click(screen.getByRole('button', { name: /^Access mapping$/ }))
        await user.click(screen.getByRole('button', { name: /^Providers$/ }))

        expect(await screen.findByText('entra')).toBeInTheDocument()
        expect(screen.queryByText(/showing drafts only/i)).toBeNull()
    })

    it('sends the rules tile to access mapping', async () => {
        const user = userEvent.setup()
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        await screen.findByText('entra')

        await user.click(screen.getByRole('button', { name: /access rules/i }))

        expect(screen.getByRole('button', { name: /^Access mapping$/ }))
            .toHaveAttribute('aria-current', 'page')
    })
})

describe('diagnostics', () => {
    it('keeps the claim-attribute lookup that lives nowhere else', () => {
        // It used to be folded inside a <details>; it is now a peer mode.
        // Either way this is the only search in the product that resolves a
        // person by something their IdP asserted, so it has to be reachable.
        render(<DiagnosticsTab />)
        expect(screen.getByRole('tab', { name: /claim attribute/i }))
            .toBeInTheDocument()
    })

    it('reaches the attribute lookup without opening anything first', async () => {
        const user = userEvent.setup()
        render(<DiagnosticsTab />)
        await user.click(screen.getByRole('tab', { name: /claim attribute/i }))
        expect(screen.getByLabelText('Attribute name')).toBeInTheDocument()
    })

    it('hides the activity log rather than locking it', () => {
        perms.value = false
        render(<DiagnosticsTab />)
        // The lookup half survives — only the audit-backed half goes away.
        expect(screen.getByText(/find a person/i)).toBeInTheDocument()
        expect(screen.queryByText(/system:audit:read/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/sign-in problems/i)).not.toBeInTheDocument()
        expect(failureDigest).not.toHaveBeenCalled()
    })

    it('leads with who is failing when the operator can read the log', async () => {
        render(<DiagnosticsTab />)
        expect(await screen.findByText('Sign-in problems')).toBeInTheDocument()
        expect(failureDigest).toHaveBeenCalled()
    })

    it('drops the reference prompt along with the log it points at', () => {
        // Telling someone to paste a reference into a search that is not
        // rendered would be worse than saying nothing.
        perms.value = false
        render(<DiagnosticsTab />)
        expect(screen.queryByText(/given a reference/i)).not.toBeInTheDocument()
    })
})
