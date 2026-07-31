/**
 * N tabs must produce one refresh, not N.
 *
 * ``refreshInFlight`` dedupes within a single JS context, so ten open
 * tabs meant ten simultaneous POSTs on the same refresh cookie. The
 * server's rotation grace window made that survivable — every racer
 * gets the same successor — but survivable is not the same as correct,
 * and proactive renewal sharpens it: every tab derives its timer from
 * the same published expiry, so they all fire on the same tick.
 *
 * A Web Lock serialises them. Whoever wins refreshes; the rest wake,
 * see the published expiry has moved, and take that as the answer.
 *
 * These tests drive the lock through the module boundary rather than
 * simulating real tabs, which a single jsdom document cannot do — each
 * ``refreshNow()`` here stands in for one tab's attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshNow, resetSessionLostLatch } from './fetchWithTimeout'

const REFRESH_URL = '/api/v1/auth/refresh'
const realFetch = globalThis.fetch
const realLocks = (navigator as { locks?: LockManager }).locks

function setExpiry(secondsFromNow: number): void {
    document.cookie = `nx_access_exp=${Math.floor(Date.now() / 1000) + secondsFromNow}`
}

function clearExpiry(): void {
    document.cookie = 'nx_access_exp=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

/**
 * The subset of the Web Locks API this code uses: exclusive, queued.
 *
 * jsdom ships no implementation, so without this the tests would
 * exercise only the no-lock fallback and prove nothing about the
 * behaviour they exist to cover.
 */
function installLockManager(): void {
    const queues = new Map<string, Promise<unknown>>()
    const request = (name: string, ...rest: unknown[]) => {
        const callback = (typeof rest[0] === 'function' ? rest[0] : rest[1]) as
            (lock: unknown) => Promise<unknown>
        const prior = queues.get(name) ?? Promise.resolve()
        const next = prior.then(() => callback({ name, mode: 'exclusive' }))
        // Keep the chain alive even if one holder rejects, or a single
        // failure would wedge the lock for the life of the page.
        queues.set(name, next.catch(() => undefined))
        return next
    }
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request },
    })
}

function removeLockManager(): void {
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: undefined,
    })
}

/** A refresh endpoint that rotates: it republishes the expiry, exactly
 *  as ``set_session_cookies`` does. */
function mockRotatingRefresh(delayMs = 0) {
    return vi.fn(async (...args: Parameters<typeof fetch>) => {
        if (String(args[0]) !== REFRESH_URL) return new Response('{}', { status: 401 })
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        setExpiry(15 * 60)
        return new Response('{}', { status: 200 })
    })
}

function refreshCalls(f: ReturnType<typeof mockRotatingRefresh>): number {
    return f.mock.calls.filter((c) => String(c[0]) === REFRESH_URL).length
}

beforeEach(() => {
    resetSessionLostLatch()
    clearExpiry()
})

afterEach(() => {
    globalThis.fetch = realFetch
    clearExpiry()
    if (realLocks) {
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: realLocks,
        })
    } else {
        removeLockManager()
    }
    vi.restoreAllMocks()
})

describe('with Web Locks available', () => {
    beforeEach(installLockManager)

    it('a later, uncontended attempt still refreshes', async () => {
        // The lock dedupes racers, not every subsequent call. An attempt
        // that starts after the previous rotation has fully settled is a
        // genuine new request — the next scheduled renewal, an hour
        // later — and must go to the server.
        setExpiry(-60)
        const f = mockRotatingRefresh()
        globalThis.fetch = f as unknown as typeof fetch

        expect(await refreshNow()).toBe('ok')
        expect(refreshCalls(f)).toBe(1)

        resetSessionLostLatch()
        expect(await refreshNow()).toBe('ok')
        expect(refreshCalls(f)).toBe(2)
    })

    it('still refreshes when the expiry has NOT moved', async () => {
        // The uncontended case, and the one a naive "does it look fresh?"
        // check would break: a 401 can mean revoked rather than expired,
        // and then the published expiry is still in the future. Skipping
        // the POST there would report success and leave a revoked session
        // erroring on every request instead of signing out.
        setExpiry(15 * 60)
        const f = vi.fn(async () => new Response('{}', { status: 401 }))
        globalThis.fetch = f as unknown as typeof fetch

        expect(await refreshNow()).toBe('expired')
        expect(f).toHaveBeenCalled()
    })

    it("takes another tab's rotation as the answer instead of posting again", async () => {
        // The case the lock exists for, and the only one a single jsdom
        // document can express: this tab decides renewal is due, queues
        // behind a holder that is already rotating, and by the time it
        // gets the lock the work is done.
        //
        // Note it CANNOT be written as two concurrent ``refreshNow()``
        // calls — ``refreshInFlight`` would collapse those into one
        // promise and the assertion would pass with the lock removed.
        // The foreign holder below is what makes this a cross-tab test.
        setExpiry(-60)
        const f = mockRotatingRefresh()
        globalThis.fetch = f as unknown as typeof fetch

        const otherTab = navigator.locks.request(
            'nx-session-refresh',
            async () => {
                await new Promise((resolve) => setTimeout(resolve, 5))
                setExpiry(15 * 60)
            },
        )

        const outcome = await refreshNow()
        await otherTab

        expect(outcome).toBe('ok')
        expect(refreshCalls(f)).toBe(0)
    })
})

describe('without Web Locks', () => {
    beforeEach(removeLockManager)

    it('still refreshes — the fallback is the old per-tab behaviour', async () => {
        // jsdom, and a handful of older browsers. Losing the lock must
        // cost coordination, never the session; the server's rotation
        // grace window already makes the uncoordinated case safe.
        setExpiry(-60)
        const f = mockRotatingRefresh()
        globalThis.fetch = f as unknown as typeof fetch

        expect(await refreshNow()).toBe('ok')
        expect(refreshCalls(f)).toBe(1)
    })
})
