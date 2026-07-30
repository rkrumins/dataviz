/**
 * Which 403s are worth telling the user about.
 *
 * The card exists to explain a refusal to someone who just asked for
 * something. It used to fire on EVERY 403 unless a caller opted out — and
 * an opt-out only ever lands on the call sites somebody thought to check,
 * so every read added later shouted by default. Background probes at
 * admin-only endpoints, whose 403 is the expected answer for most tiers,
 * therefore popped "Access denied" over a page that was loading perfectly
 * well. That is the half of "it briefly says I don't have permission" that
 * is not a route guard at all.
 *
 * The method carries the distinction already: a probe is a GET, clicking
 * Delete is a DELETE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchWithTimeout } from './fetchWithTimeout'

const forbidden = () =>
    new Response(JSON.stringify({ detail: { message: 'Missing permission: system:admin' } }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
    })

let denials: number
let originalFetch: typeof globalThis.fetch

function onDenied() {
    denials += 1
}

beforeEach(() => {
    denials = 0
    window.addEventListener('auth:access-denied', onDenied)
    originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => forbidden()) as unknown as typeof fetch
})

afterEach(() => {
    window.removeEventListener('auth:access-denied', onDenied)
    globalThis.fetch = originalFetch
})

/** The event is dispatched from an async body-read, so let it land. */
async function settle() {
    await new Promise((r) => setTimeout(r, 0))
}


describe('403 surfacing', () => {
    it('stays quiet for a background read', async () => {
        // THE REGRESSION. A GET nobody initiated must not announce
        // anything, however denied it is.
        await fetchWithTimeout('/api/v1/admin/context-model-templates')
        await settle()

        expect(denials).toBe(0)
    })

    it('announces a denied mutation', async () => {
        // The user pressed something. Silence here is the opposite
        // failure: an action that quietly does nothing.
        await fetchWithTimeout('/api/v1/views/v_1', { method: 'DELETE' })
        await settle()

        expect(denials).toBe(1)
    })

    it('announces a read that asked to be surfaced', async () => {
        // Some reads ARE user-initiated and worth explaining; they opt in
        // rather than everything opting out.
        await fetchWithTimeout('/api/v1/admin/users', { surface403: true })
        await settle()

        expect(denials).toBe(1)
    })

    it('lets a mutation opt out when its 403 is an ordinary answer', async () => {
        // Submitting the wrong current password comes back 403 and the
        // form renders that itself — announcing it twice is noise.
        await fetchWithTimeout('/api/v1/users/me/password', {
            method: 'POST', silent403: true,
        })
        await settle()

        expect(denials).toBe(0)
    })

    it('gives silent403 the last word over surface403', async () => {
        // One of them has to win, and "never announce this" is the more
        // specific instruction.
        await fetchWithTimeout('/api/v1/anything', {
            method: 'POST', silent403: true, surface403: true,
        })
        await settle()

        expect(denials).toBe(0)
    })
})
