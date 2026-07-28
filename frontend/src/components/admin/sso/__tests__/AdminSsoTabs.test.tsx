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

const { listProviders, listGroupMappings, auditList } = vi.hoisted(() => ({
    listProviders: vi.fn(),
    listGroupMappings: vi.fn(),
    auditList: vi.fn(),
}))

vi.mock('@/services/ssoAdminService', () => ({
    ssoAdminService: {
        listProviders,
        listGroupMappings,
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
})

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
    it('offers four tabs and no longer a Find user tab', () => {
        render(<MemoryRouter><AdminSso /></MemoryRouter>)
        for (const name of [/^Providers$/, /Access mapping/, /Diagnostics/, /^Settings$/]) {
            expect(screen.getByRole('button', { name })).toBeInTheDocument()
        }
        expect(screen.queryByRole('button', { name: /find user/i })).not.toBeInTheDocument()
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
        expect(auditList).not.toHaveBeenCalled()
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
    })

    it('drops the reference prompt along with the log it points at', () => {
        // Telling someone to paste a reference into a search that is not
        // rendered would be worse than saying nothing.
        perms.value = false
        render(<DiagnosticsTab />)
        expect(screen.queryByText(/given a reference/i)).not.toBeInTheDocument()
    })
})
