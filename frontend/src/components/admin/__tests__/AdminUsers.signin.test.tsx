/**
 * The Sign-in column: who is local, who is SSO, and from which IdP.
 *
 * The user table showed status, role and join date — nothing about how
 * an account signs in, so telling a directory-provisioned account from
 * a password one meant opening the SSO Diagnostics tab one user at a
 * time. These tests pin the chips: Local, provider-by-name, both, the
 * +N collapse, the stranded no-sign-in state, and search matching
 * provider names.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/adminUserService', () => ({
    adminUserService: {
        listUsers: vi.fn(),
    },
}))
vi.mock('@/services/permissionsService', () => ({
    permissionsService: { getUserAccess: vi.fn() },
}))
vi.mock('@/store/features', () => ({ useFeature: () => false }))
vi.mock('@/store/auth', () => ({ usePermission: () => true }))
vi.mock('../AdminInvites', () => ({ AdminInvites: () => null }))
vi.mock('../InviteWizard', () => ({ InviteWizard: () => null }))
vi.mock('../CreateUserWizard', () => ({ CreateUserWizard: () => null }))
vi.mock('@/components/access/AccessSummary', () => ({
    AccessSummary: () => null,
}))

import { AdminUsers } from '../AdminUsers'
import {
    adminUserService,
    type AdminUserResponse,
    type AdminUserIdentityRef,
} from '@/services/adminUserService'

const listUsers = vi.mocked(adminUserService.listUsers)

function identity(over: Partial<AdminUserIdentityRef> = {}): AdminUserIdentityRef {
    return {
        providerId: 'idp_1', slug: 'corp-entra',
        displayName: 'Corporate Entra', kind: 'oidc',
        lastLoginAt: new Date().toISOString(),
        ...over,
    }
}

function user(over: Partial<AdminUserResponse> = {}): AdminUserResponse {
    return {
        id: 'usr_1', email: 'ada@example.com',
        firstName: 'Ada', lastName: 'Lovelace', displayName: 'Ada Lovelace',
        status: 'active', role: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resetRequested: false, mustChangePassword: false,
        hasPassword: true, signupSource: 'local_signup', identities: [],
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    listUsers.mockResolvedValue([user()])
})

describe('the sign-in column', () => {
    it('a password-only account reads Local', async () => {
        render(<AdminUsers />)
        expect(await screen.findByText('Local')).toBeInTheDocument()
    })

    it('an SSO account names its provider instead', async () => {
        listUsers.mockResolvedValue([user({
            hasPassword: false, signupSource: 'sso_jit',
            identities: [identity()],
        })])
        render(<AdminUsers />)
        expect(await screen.findByText('Corporate Entra')).toBeInTheDocument()
        expect(screen.queryByText('Local')).not.toBeInTheDocument()
    })

    it('an account with both shows the provider and a key', async () => {
        listUsers.mockResolvedValue([user({
            hasPassword: true, identities: [identity()],
        })])
        render(<AdminUsers />)
        expect(await screen.findByText('Corporate Entra')).toBeInTheDocument()
        expect(screen.getByLabelText('Also has a password')).toBeInTheDocument()
        expect(screen.queryByText('Local')).not.toBeInTheDocument()
    })

    it('collapses past two providers into +N', async () => {
        listUsers.mockResolvedValue([user({
            hasPassword: false,
            identities: [
                identity(),
                identity({ providerId: 'idp_2', slug: 'okta', displayName: 'Corp Okta' }),
                identity({ providerId: 'idp_3', slug: 'gw', displayName: 'Gateway', kind: 'backchannel' }),
            ],
        })])
        render(<AdminUsers />)
        expect(await screen.findByText('Corporate Entra')).toBeInTheDocument()
        expect(screen.getByText('Corp Okta')).toBeInTheDocument()
        expect(screen.queryByText('Gateway')).not.toBeInTheDocument()
        expect(screen.getByText('+1')).toBeInTheDocument()
    })

    it('an account with no way in says so', async () => {
        listUsers.mockResolvedValue([user({
            hasPassword: false, identities: [],
        })])
        render(<AdminUsers />)
        expect(await screen.findByText('No sign-in')).toBeInTheDocument()
    })

    it('search matches provider names, so "who comes from Entra" is one query', async () => {
        listUsers.mockResolvedValue([
            user({ id: 'usr_sso', email: 'sso@example.com', displayName: 'Sso Person',
                   hasPassword: false, identities: [identity()] }),
            user({ id: 'usr_local', email: 'local@example.com', displayName: 'Local Person' }),
        ])
        const u = userEvent.setup()
        render(<AdminUsers />)
        expect(await screen.findByText('Sso Person')).toBeInTheDocument()
        expect(screen.getByText('Local Person')).toBeInTheDocument()

        await u.type(
            screen.getByPlaceholderText(/search by name, email, role, or provider/i),
            'entra',
        )
        await waitFor(() => {
            expect(screen.queryByText('Local Person')).not.toBeInTheDocument()
        })
        expect(screen.getByText('Sso Person')).toBeInTheDocument()
    })
})
