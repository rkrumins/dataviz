/**
 * Signing out has to stick.
 *
 * Two things could sign a user back in without them typing anything: the
 * refresh cookie (any route with a live one restores silently) and a
 * ``custom_profile`` payload in browser storage (the login page reads it
 * and mints a NEW session — server-side revocation cannot touch that,
 * because it isn't presenting a condemned credential, it is asking for a
 * fresh one).
 *
 * The marker is scoped to EXPLICIT sign-out on purpose. An ordinary token
 * expiry must still restore silently, or the "leave it open and come
 * back" case this whole change is about breaks in a new way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearSignedOut, isSignedOut, markSignedOut } from './signedOut'

beforeEach(() => {
    localStorage.clear()
})

describe('the signed-out marker', () => {
    it('is absent until someone actually signs out', () => {
        // The default must be "not signed out", or a first-time visitor is
        // locked out of the silent-refresh path they have never used.
        expect(isSignedOut()).toBe(false)
    })

    it('records an explicit sign-out', () => {
        markSignedOut()
        expect(isSignedOut()).toBe(true)
    })

    it('is cleared by signing back in', () => {
        markSignedOut()
        clearSignedOut()
        expect(isSignedOut()).toBe(false)
    })

    it('survives into another tab', () => {
        // localStorage, not sessionStorage, and this is why: the portal
        // payload is readable by any tab, so a per-tab marker would let a
        // newly-opened one sign you straight back in.
        markSignedOut()
        expect(localStorage.getItem('nx_signed_out')).toBe('1')
    })

    it('degrades to "not signed out" when storage is unavailable', () => {
        // Private mode and blocked-cookie browsers throw on access. A
        // missing marker must never break sign-in or sign-out; the
        // server-side revocation still covers the refresh path.
        const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError')
        })
        expect(isSignedOut()).toBe(false)
        spy.mockRestore()
    })

    it('does not throw when marking is impossible', () => {
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError')
        })
        expect(() => markSignedOut()).not.toThrow()
        spy.mockRestore()
    })
})
