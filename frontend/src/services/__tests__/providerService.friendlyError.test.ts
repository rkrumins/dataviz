import { describe, it, expect } from 'vitest'

import { friendlyError } from '../providerService'

describe('friendlyError auth classification', () => {
    it('maps auth_required (server requires auth, none provided)', () => {
        const msg = friendlyError('auth_required')
        expect(msg.toLowerCase()).toContain('requires authentication')
        expect(msg.toLowerCase()).toContain('sending none')
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

import { isDriftError } from '../providerService'

describe('isDriftError / cluster_mode_mismatch mapping', () => {
    it('recognizes graph_drift-prefixed last_error strings', () => {
        expect(isDriftError('graph_drift: 3 registered graph(s) missing from this provider (e.g. a, b, c)')).toBe(true)
    })

    it('rejects other errors, null, and undefined', () => {
        expect(isDriftError('tcp_refused: falkordb:6379')).toBe(false)
        expect(isDriftError(null)).toBe(false)
        expect(isDriftError(undefined)).toBe(false)
        expect(isDriftError('')).toBe(false)
    })

    it('maps cluster_mode_mismatch to an actionable message', () => {
        const msg = friendlyError('cluster_mode_mismatch')
        expect(msg.toLowerCase()).toContain('cluster')
        expect(msg.toLowerCase()).toContain('standalone')
    })
})
