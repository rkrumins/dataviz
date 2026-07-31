/**
 * Renewal has to happen before the token dies, not after the 401.
 *
 * The reactive path still works — these do not replace it. What they
 * pin is that an idle tab renews on its own, that it renews from what
 * the server published rather than from a hardcoded interval, and that
 * it stops when the session is genuinely gone instead of retrying a
 * settled answer forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    enableSessionKeepalive,
    disableSessionKeepalive,
} from './sessionKeepalive'
import { SESSION_REFRESHED_EVENT } from '@/services/fetchWithTimeout'

const refreshNow = vi.hoisted(() => vi.fn())

vi.mock('@/services/fetchWithTimeout', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/fetchWithTimeout')>()
    return { ...actual, refreshNow }
})

/** Publish an access expiry the way the backend does. */
function setExpiry(secondsFromNow: number): void {
    document.cookie = `nx_access_exp=${Math.floor(Date.now() / 1000) + secondsFromNow}`
}

function clearExpiry(): void {
    document.cookie = 'nx_access_exp=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
}

beforeEach(() => {
    vi.useFakeTimers()
    refreshNow.mockReset()
    // The real thing rotates the cookies, which republishes the expiry.
    // A mock that only resolved 'ok' would leave the module re-arming
    // against an instant already past — a spin the production code
    // guards against separately (see the "achieves nothing" test).
    refreshNow.mockImplementation(async () => {
        setExpiry(15 * 60)
        return 'ok'
    })
    clearExpiry()
})

afterEach(() => {
    disableSessionKeepalive()
    clearExpiry()
    vi.useRealTimers()
})

describe('proactive renewal', () => {
    it('renews before the published expiry, without a request having 401d', async () => {
        // 15-minute token, the shipped access TTL.
        setExpiry(15 * 60)
        enableSessionKeepalive()

        // Nothing yet — the whole point is that it does not refresh on
        // every tick.
        await vi.advanceTimersByTimeAsync(13 * 60 * 1000)
        expect(refreshNow).not.toHaveBeenCalled()

        // ...and it fires before expiry, not after.
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalledTimes(1)
    })

    it('renews immediately when the tab wakes past the renewal point', async () => {
        // A tab restored from the background, or one whose throttled
        // timer never got a slot: the token is nearly dead on arrival.
        setExpiry(5)
        enableSessionKeepalive()

        await vi.advanceTimersByTimeAsync(3_000)
        expect(refreshNow).toHaveBeenCalledTimes(1)
    })

    it('re-arms against the NEW expiry after each renewal', async () => {
        // Renewal is not a fixed-interval timer: each hop reads what the
        // last rotation published. One renewal per token lifetime, not
        // one per arbitrary interval.
        setExpiry(15 * 60)
        enableSessionKeepalive()

        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalledTimes(2)

        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalledTimes(3)
    })

    it('backs off when a renewal achieves nothing', async () => {
        // The pathological case: the call succeeds but the published
        // expiry does not move — a backend too old to publish it, or a
        // cookie the browser refused. Re-arming off an instant already
        // past lands on the floor delay every time, which is a request
        // storm aimed at our own auth endpoint.
        refreshNow.mockResolvedValue('ok')
        setExpiry(5)
        enableSessionKeepalive()

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        // Five minutes at the probe interval, not at the 2s floor.
        expect(refreshNow.mock.calls.length).toBeLessThanOrEqual(6)
        expect(refreshNow).toHaveBeenCalled()
    })
})

describe('when there is nothing to schedule against', () => {
    it('does not renew blind', async () => {
        // A session that predates the expiry cookie. The reactive 401
        // path still covers this tab; guessing at a renewal here would
        // be a POST we have no reason to believe is due.
        enableSessionKeepalive()
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        expect(refreshNow).not.toHaveBeenCalled()
    })

    it('picks up an expiry that appears later', async () => {
        enableSessionKeepalive()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(refreshNow).not.toHaveBeenCalled()

        // The reactive path rotated and the backend published one.
        setExpiry(15 * 60)
        await vi.advanceTimersByTimeAsync(60_000)
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalled()
    })
})

describe('stopping', () => {
    it('stops for good once the session is definitively gone', async () => {
        // 'expired' means the server answered "that session does not
        // exist". The store is already signing out; asking again is
        // asking a settled question.
        refreshNow.mockResolvedValue('expired')
        setExpiry(5)
        enableSessionKeepalive()

        await vi.advanceTimersByTimeAsync(3_000)
        expect(refreshNow).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalledTimes(1)
    })

    it('keeps trying after a failure that says nothing about the session', async () => {
        // 429 / 5xx / offline. Giving up here would leave the tab with
        // no proactive renewal for the rest of its life because the
        // network blipped once.
        refreshNow.mockResolvedValue('retryable')
        setExpiry(5)
        enableSessionKeepalive()

        await vi.advanceTimersByTimeAsync(3_000)
        expect(refreshNow).toHaveBeenCalledTimes(1)

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        expect(refreshNow.mock.calls.length).toBeGreaterThan(1)
    })

    it('renews nothing after disable', async () => {
        setExpiry(15 * 60)
        enableSessionKeepalive()
        disableSessionKeepalive()

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
        expect(refreshNow).not.toHaveBeenCalled()
    })

    it('is idempotent — a second enable does not double the timers', async () => {
        // The app shell calls this from an effect that re-runs on every
        // remount. Two chains would mean two rotations per window.
        setExpiry(15 * 60)
        enableSessionKeepalive()
        enableSessionKeepalive()
        enableSessionKeepalive()

        await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalledTimes(1)
    })
})

describe('another tab rotated', () => {
    it('re-arms without refreshing again', async () => {
        setExpiry(15 * 60)
        enableSessionKeepalive()

        // Cookies are shared across tabs: the other tab's rotation lands
        // in this tab's jar, and its refresh event reaches this module.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        setExpiry(15 * 60)
        window.dispatchEvent(new CustomEvent(SESSION_REFRESHED_EVENT))

        // The original slot passes with nothing to do...
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        expect(refreshNow).not.toHaveBeenCalled()

        // ...and this tab renews against the newer expiry instead.
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
        expect(refreshNow).toHaveBeenCalledTimes(1)
    })
})
