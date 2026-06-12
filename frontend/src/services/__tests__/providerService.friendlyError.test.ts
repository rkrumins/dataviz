import { describe, it, expect } from 'vitest'

import { friendlyError } from '../providerService'

describe('friendlyError auth classification', () => {
    it('maps auth_required (server requires auth, none provided)', () => {
        const msg = friendlyError('auth_required')
        expect(msg.toLowerCase()).toContain('requires authentication')
        expect(msg.toLowerCase()).toContain('no credentials')
    })

    it('maps auth_failed (credentials rejected)', () => {
        const msg = friendlyError('auth_failed')
        expect(msg.toLowerCase()).toContain('rejected')
    })

    it('distinguishes the two — they are different messages', () => {
        expect(friendlyError('auth_required')).not.toBe(friendlyError('auth_failed'))
    })

    it('maps the /test JSON envelope by reason code', () => {
        expect(friendlyError(JSON.stringify({ success: false, error: 'auth_required' })))
            .toBe(friendlyError('auth_required'))
    })

    it('classifies raw NOAUTH driver strings as auth_required', () => {
        const msg = friendlyError('-NOAUTH Authentication required.')
        expect(msg).toBe(friendlyError('auth_required'))
    })

    it('classifies raw WRONGPASS driver strings as auth_failed', () => {
        const msg = friendlyError('redis_error: -WRONGPASS invalid username-password pair')
        expect(msg).toBe(friendlyError('auth_failed'))
    })
})
