/**
 * The wizard's rules, tested without rendering five screens of chrome.
 *
 * The one that matters: **you cannot publish what you have not
 * rehearsed.** Everything else in the flow is convenience; that gate is
 * what makes "nothing reaches your users until you have signed in through
 * it yourself" a guarantee instead of a slogan.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useIdpConnectionWizard, slugify } from '../useIdpConnectionWizard'

const { discover, createProvider, publishProvider } = vi.hoisted(() => ({
    discover: vi.fn(),
    createProvider: vi.fn(),
    publishProvider: vi.fn(),
}))

vi.mock('@/services/ssoAdminService', async () => {
    const actual = await vi.importActual<typeof import('@/services/ssoAdminService')>(
        '@/services/ssoAdminService',
    )
    return {
        ...actual,
        ssoAdminService: {
            ...actual.ssoAdminService,
            discover, createProvider, publishProvider,
        },
    }
})

beforeEach(() => {
    vi.clearAllMocks()
    createProvider.mockResolvedValue({ id: 'idp_1', slug: 'x', lifecycle: 'draft' })
    publishProvider.mockResolvedValue({ id: 'idp_1', slug: 'x', lifecycle: 'live' })
    discover.mockResolvedValue({ success: true, settings: { issuer: 'https://i' } })
})


describe('slugify', () => {
    it('turns a typed name into something URL-safe', () => {
        expect(slugify('Corporate Entra ID')).toBe('corporate-entra-id')
    })

    it('drops leading and trailing separators', () => {
        // The slug is baked into the redirect URI registered at the IdP,
        // so a stray dash is a mismatch the operator would have to debug.
        expect(slugify('  --Okta!  ')).toBe('okta')
    })
})


describe('the gate on publishing', () => {
    it('will not leave the rehearse step until a rehearsal happened', () => {
        const { result } = renderHook(() => useIdpConnectionWizard())

        act(() => { result.current.choose('entra') })
        act(() => { result.current.setDisplayName('Corp') })
        act(() => { result.current.setStep('rehearse') })

        expect(result.current.canAdvance).toBe(false)

        act(() => { result.current.setRehearsed(true) })
        expect(result.current.canAdvance).toBe(true)
    })
})


describe('choosing a provider', () => {
    it('seeds the claim mapping from the vendor', () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })

        // Entra's UPN spelling — the thing an operator would otherwise
        // have to know to type by hand.
        expect(result.current.claimMapping.email)
            .toContain('preferred_username')
    })

    it('replaces the mapping when the vendor changes', () => {
        // Leaving Entra's claim names on an Okta connection is exactly the
        // mistake the presets exist to prevent.
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.choose('okta') })

        expect(result.current.claimMapping.email).not.toContain('preferred_username')
        expect(result.current.claimMapping.email).toContain('email')
    })

    it('offers the vendor name as a starting display name', () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('okta') })
        expect(result.current.displayName).toBe('Okta')
    })

    it('does not clobber a name the operator already typed', () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.setDisplayName('Staff login') })
        act(() => { result.current.choose('okta') })
        expect(result.current.displayName).toBe('Staff login')
    })

    it('blocks the first step until something is chosen', () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        expect(result.current.canAdvance).toBe(false)
        act(() => { result.current.choose('entra') })
        expect(result.current.canAdvance).toBe(true)
    })
})


describe('the connect step', () => {
    it('needs a name, because the name becomes the URL', () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setDisplayName('') })
        act(() => { result.current.setStep('connect') })
        expect(result.current.canAdvance).toBe(false)

        act(() => { result.current.setDisplayName('Corp Entra') })
        expect(result.current.canAdvance).toBe(true)
    })

    it('merges what discovery found into the settings', async () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setConnectInput('https://login.microsoftonline.com/t/v2.0') })

        await act(async () => { await result.current.runDiscovery() })

        expect(result.current.settings.issuer).toBe('https://i')
    })

    it('sends pasted XML as metadata rather than as a URL', async () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('adfs') })
        act(() => { result.current.setConnectInput('<EntityDescriptor/>') })

        await act(async () => { await result.current.runDiscovery() })

        expect(discover).toHaveBeenCalledWith(
            expect.objectContaining({ metadataXml: '<EntityDescriptor/>' }),
        )
    })

    it('does not block the flow when the IdP is unreachable', async () => {
        // A probe failure is an answer, not a dead end — the operator may
        // have the values to hand and type them.
        discover.mockResolvedValue({ success: false, error: 'unreachable' })
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setDisplayName('Corp') })
        act(() => { result.current.setConnectInput('https://nope') })

        await act(async () => { await result.current.runDiscovery() })

        act(() => { result.current.setStep('connect') })
        expect(result.current.canAdvance).toBe(true)
    })
})


describe('the mapping step', () => {
    it('requires the two fields the backend refuses to resolve without', () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setStep('map') })
        expect(result.current.canAdvance).toBe(true)

        act(() => { result.current.setClaimMapping({ email: ['email'] }) })
        expect(result.current.canAdvance).toBe(false)   // no external_id

        act(() => { result.current.setClaimMapping({ external_id: ['sub'] }) })
        expect(result.current.canAdvance).toBe(false)   // no email
    })
})


describe('creating and publishing', () => {
    it('creates nothing until the rehearse step needs it', async () => {
        // An abandoned wizard should leave no rows behind.
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setDisplayName('Corp') })
        act(() => { result.current.setStep('map') })

        expect(createProvider).not.toHaveBeenCalled()

        await act(async () => { await result.current.createDraft() })
        expect(createProvider).toHaveBeenCalledTimes(1)
    })

    it('does not create a second row on a repeated rehearsal', async () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setDisplayName('Corp') })

        await act(async () => { await result.current.createDraft() })
        await act(async () => { await result.current.createDraft() })

        expect(createProvider).toHaveBeenCalledTimes(1)
    })

    it('publishes the draft it created', async () => {
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setDisplayName('Corp') })
        await act(async () => { await result.current.createDraft() })

        await act(async () => { await result.current.publish() })

        expect(publishProvider).toHaveBeenCalledWith('idp_1')
        await waitFor(() =>
            expect(result.current.provider?.lifecycle).toBe('live'))
    })

    it('surfaces a failure instead of silently doing nothing', async () => {
        createProvider.mockRejectedValue(new Error('slug already exists'))
        const { result } = renderHook(() => useIdpConnectionWizard())
        act(() => { result.current.choose('entra') })
        act(() => { result.current.setDisplayName('Corp') })

        await act(async () => { await result.current.createDraft() })

        await waitFor(() =>
            expect(result.current.error).toBe('slug already exists'))
    })
})
