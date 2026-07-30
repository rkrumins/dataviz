/**
 * ``?next=`` comes from the URL, so an attacker chooses it.
 *
 * The client half of the backend's ``_safe_next`` guard. Both halves
 * exist because both sides navigate to it: the backend on the SSO
 * round trip, the login page after a password sign-in.
 */
import { describe, expect, it } from 'vitest'

import { safeNext } from './safeNext'

describe('safeNext', () => {
    it('keeps an ordinary in-app path', () => {
        expect(safeNext('/workspaces/ws_1?tab=views')).toBe('/workspaces/ws_1?tab=views')
    })

    it('falls back when nothing was supplied', () => {
        expect(safeNext(null)).toBe('/')
        expect(safeNext(undefined)).toBe('/')
        expect(safeNext('')).toBe('/')
    })

    it('refuses an absolute URL', () => {
        expect(safeNext('https://evil.example/steal')).toBe('/')
    })

    it('refuses a protocol-relative URL', () => {
        // The one that catches people out: it starts with a slash, so a
        // naive startsWith('/') passes it, and the browser reads it as
        // an absolute URL on another host.
        expect(safeNext('//evil.example')).toBe('/')
    })

    it('refuses a backslash-smuggled host', () => {
        // Some browsers normalise the backslash to a forward slash,
        // turning this into the protocol-relative case above AFTER a
        // startsWith('//') check has already let it through.
        expect(safeNext('/\\evil.example')).toBe('/')
    })

    it('refuses a javascript: URL', () => {
        expect(safeNext('javascript:alert(1)')).toBe('/')
    })

    it('honours a caller-supplied fallback', () => {
        expect(safeNext(null, '/dashboard')).toBe('/dashboard')
        expect(safeNext('//evil.example', '/dashboard')).toBe('/dashboard')
    })
})
