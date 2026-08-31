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

describe('provider catalog reason codes (PR 2)', () => {
    it('still maps tls_handshake (pre-existing — regression pin, not new here)', () => {
        const msg = friendlyError('tls_handshake')
        expect(msg.toLowerCase()).toContain('tls')
    })

    it('maps the /test-connection error field for an HTTP-speaking provider that did not classify its status', () => {
        const msg = friendlyError(JSON.stringify({ success: false, error: 'http_status_503' }))
        expect(msg).toContain('503')
    })

    it('maps a bare http_status_<nnn> string the same way as the JSON envelope', () => {
        expect(friendlyError('http_status_503')).toBe(friendlyError(JSON.stringify({ success: false, error: 'http_status_503' })))
    })

    it('passes the descriptor\'s own message through for provider_config_invalid rather than the raw envelope', () => {
        const msg = friendlyError(JSON.stringify({
            detail: { type: 'provider_config_invalid', providerType: 'spanner', message: 'Spanner does not accept a host/port connection.' },
        }))
        expect(msg).toBe('Spanner does not accept a host/port connection.')
    })

    it('passes the descriptor\'s own message through for provider_unsupported the same way', () => {
        const msg = friendlyError(JSON.stringify({
            detail: { type: 'provider_unsupported', providerType: 'mock', message: 'mock providers are not supported.' },
        }))
        expect(msg).toBe('mock providers are not supported.')
    })
})
