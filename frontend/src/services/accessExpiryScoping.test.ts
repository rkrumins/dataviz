/**
 * The renewal schedule must come from THIS deployment's expiry cookie.
 *
 * Cookie jars are keyed by domain, so two deployments beneath one parent
 * domain — `a.app.example.com` and `b.app.example.com` with
 * `AUTH_COOKIE_DOMAIN=.app.example.com` — write into the same jar. The
 * signature-bearing cookies are name-scoped and stay disjoint;
 * `nx_access_exp` was not, so both backends wrote one slot and the last
 * writer decided when *every* tab renewed.
 *
 * That is not a rounding error in the schedule. The keepalive arms at
 * `expiry - 60s`, so a sibling's LATER expiry arms past this tab's own
 * token death: no proactive rotation, fall back to reactive 401 refresh,
 * and an idle tab issues no request to take a 401 with. The session
 * lapses exactly as it did before the keepalive existed.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { readAccessExpiryMs, setAuthEnvironmentId } from './fetchWithTimeout'

function put(name: string, secondsFromNow: number): void {
    document.cookie = `${name}=${Math.floor(Date.now() / 1000) + secondsFromNow}`
}

function drop(name: string): void {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

const ALL = ['nx_access_exp', 'nx_access_exp_a', 'nx_access_exp_b']

beforeEach(() => {
    ALL.forEach(drop)
    setAuthEnvironmentId(null)
})

describe('access-expiry cookie scoping', () => {
    it('reads its own environment and ignores a sibling deployment', () => {
        // The sibling rotated more recently, so its expiry is further out.
        put('nx_access_exp_a', 120)
        put('nx_access_exp_b', 3600)
        setAuthEnvironmentId('a')

        const ms = readAccessExpiryMs()

        expect(ms).not.toBeNull()
        const secondsAway = Math.round((ms! - Date.now()) / 1000)
        expect(secondsAway).toBeGreaterThan(100)
        expect(secondsAway).toBeLessThan(200)
    })

    it('never adopts a later sibling expiry, which is the failure mode', () => {
        put('nx_access_exp_a', 60)
        put('nx_access_exp_b', 86_400)
        setAuthEnvironmentId('a')

        const ms = readAccessExpiryMs()

        // Reading b's value would arm the timer a day out, so this tab's
        // own token would die roughly 23 hours before it ever rotated.
        expect(ms! - Date.now()).toBeLessThan(10 * 60 * 1000)
    })

    it('falls back to the unscoped name before bootstrap has answered', () => {
        // A tab that has not yet called /auth/me, or a backend too old to
        // scope the cookie. Dropping to null here would leave the
        // scheduler on its 60s probe for the life of the tab.
        put('nx_access_exp', 300)

        expect(readAccessExpiryMs()).not.toBeNull()
    })

    it('prefers the scoped cookie over a stale unscoped leftover', () => {
        // Mid-rollout: the pre-upgrade cookie is still in the jar and has
        // drifted into the past. Reading it would arm at the floor delay
        // and renew on a loop against an instant that never advances.
        put('nx_access_exp', -600)
        put('nx_access_exp_a', 900)
        setAuthEnvironmentId('a')

        expect(readAccessExpiryMs()! - Date.now()).toBeGreaterThan(0)
    })

    it('uses the unscoped name when no environment id is configured', () => {
        // The single-deployment install, which is most of them: the
        // backend scopes nothing and /auth/me reports no environment.
        put('nx_access_exp', 300)
        setAuthEnvironmentId(undefined)

        expect(readAccessExpiryMs()).not.toBeNull()
    })
})
