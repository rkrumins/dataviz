/**
 * Ask to keep it: offered beside your own grants made here that end ahead —
 * never for the identity provider's, a team's, one with no end or one that
 * has ended — and replaced by "Asked to keep it" while a request is open.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { extend, notify } = vi.hoisted(() => ({ extend: vi.fn(), notify: vi.fn() }))
vi.mock('@/services/accessRequestsService', async (orig) => ({
    ...(await orig<typeof import('@/services/accessRequestsService')>()),
    accessRequestsService: { extend },
}))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

import { KeepAccessButton } from '../KeepAccessButton'
import type { AccessBinding } from '@/services/permissionsService'
import type { AccessRequestResponse } from '@/services/accessRequestsService'

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString()

function binding(over: Partial<AccessBinding> = {}): AccessBinding {
    return {
        bindingId: 'bnd_1', role: 'workspace_member',
        scope: { type: 'workspace', id: 'ws_fin', label: 'Finance' },
        grantedAt: '2026-10-01T00:00:00Z', grantedBy: 'usr_wanda', viaGroup: null,
        expiresAt: inDays(5),
        provenance: { origin: 'direct', source: null, by: 'usr_wanda', at: null, requestId: null, idpGroups: [], idpProvider: null },
        ...over,
    }
}

function renderButton(b: AccessBinding, requests: AccessRequestResponse[] = []) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
        <QueryClientProvider client={client}>
            <KeepAccessButton binding={b} requests={requests} />
        </QueryClientProvider>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    extend.mockResolvedValue({ id: 'ar_1', status: 'pending' })
})

describe('KeepAccessButton', () => {
    it.each([
        ['no end date', { expiresAt: null }],
        ['an end already past', { expiresAt: inDays(-1) }],
        ['a team’s grant', { viaGroup: { id: 'grp_a', name: 'Auditors' } }],
        ['a platform role', { scope: { type: 'global' as const, id: null, label: null } }],
        ['the identity provider’s grant', { provenance: { ...binding().provenance!, origin: 'idp' as const } }],
    ])('is not offered for %s', (_what, over) => {
        renderButton(binding(over))
        expect(screen.queryByRole('button', { name: 'Ask to keep it' })).not.toBeInTheDocument()
    })

    it('asks to keep it, with why', async () => {
        const user = userEvent.setup()
        renderButton(binding())
        await user.click(screen.getByRole('button', { name: 'Ask to keep it' }))
        const dialog = screen.getByRole('dialog', { name: 'Keep your access to Finance' })
        expect(dialog).toHaveTextContent('Your Member access ends on')
        await user.type(screen.getByRole('textbox'), 'The audit runs late')
        await user.click(screen.getAllByRole('button', { name: 'Ask to keep it' }).at(-1)!)

        await waitFor(() => expect(extend).toHaveBeenCalledWith({ bindingId: 'bnd_1', justification: 'The audit runs late' }))
        expect(notify).toHaveBeenCalledWith('success', 'Asked to keep your access to Finance.')
    })

    it('says so while a request to keep it is open', () => {
        renderButton(binding(), [{ bindingId: 'bnd_1', status: 'pending' } as AccessRequestResponse])
        expect(screen.getByText('Asked to keep it')).toBeInTheDocument()
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })
})
