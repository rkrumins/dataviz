import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RETRY_MAX_MS, RIDE_OUT_MS, rideOut, rideOutDelayMs, waitsOut } from '../rideOut'


/** What the request layer throws for an HTTP error. */
const apiError = (status: number, code?: string, retryAfterMs?: number) => Object.assign(
    new Error(`API Error ${status}: {}`),
    { status, ...(code ? { code } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
)


describe('waitsOut — what a graph that can’t answer just now looks like', () => {
    it.each([
        ['a full fleet', apiError(429, 'PROVIDER_BUSY')],
        ['a failover', apiError(503, 'PROVIDER_FAILING_OVER')],
        ['a store that is down', apiError(503, 'PROVIDER_UNAVAILABLE')],
        ['the sessions’ cache down', apiError(503, 'SEARCH_STORE_UNAVAILABLE')],
        ['a gateway', apiError(502)],
        ['a slow read', apiError(504, 'PROVIDER_TIMEOUT')],
        ['no answer at all', new TypeError('Failed to fetch')],
        ['the request layer’s breaker', new Error('Provider unavailable (circuit open)')],
    ])('waits out %s', (_why, err) => {
        expect(waitsOut(err)).toBe(true)
    })

    it.each([
        ['a refused query', apiError(400)],
        ['no permission', apiError(403)],
        ['a search the server could not finish', apiError(500, 'SEARCH_FAILED')],
        ['a bug', new RangeError('bad index')],
    ])('does not wait out %s', (_why, err) => {
        expect(waitsOut(err)).toBe(false)
    })
})


describe('rideOutDelayMs', () => {
    beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0) })
    afterEach(() => { vi.restoreAllMocks() })

    it('doubles from a second, never under the server’s Retry-After, never over the cap', () => {
        expect([0, 1, 2, 3, 4, 7].map((a) => rideOutDelayMs(apiError(503), a)))
            .toEqual([1000, 2000, 4000, 8000, RETRY_MAX_MS, RETRY_MAX_MS])
        expect(rideOutDelayMs(apiError(503, 'PROVIDER_LOADING', 5000), 0)).toBe(5000)
        expect(rideOutDelayMs(apiError(503, 'PROVIDER_UNAVAILABLE', 30_000), 0)).toBe(RETRY_MAX_MS)
    })
})


describe('rideOut', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('asks again until the graph answers', async () => {
        const ask = vi.fn()
            .mockRejectedValueOnce(apiError(429, 'PROVIDER_BUSY', 1000))
            .mockRejectedValueOnce(apiError(503, 'PROVIDER_FAILING_OVER', 3000))
            .mockResolvedValueOnce('answer')
        const answer = rideOut(ask)
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(answer).resolves.toBe('answer')
        expect(ask).toHaveBeenCalledTimes(3)
    })

    it('throws anything else at once', async () => {
        const ask = vi.fn().mockRejectedValue(apiError(500, 'SEARCH_FAILED'))
        await expect(rideOut(ask)).rejects.toMatchObject({ status: 500 })
        expect(ask).toHaveBeenCalledTimes(1)
    })

    it('gives up when the graph stays out of reach for the whole window', async () => {
        const ask = vi.fn().mockRejectedValue(apiError(503, 'PROVIDER_UNAVAILABLE'))
        const asked = rideOut(ask)
        const outcome = expect(asked).rejects.toMatchObject({ status: 503 })
        await vi.advanceTimersByTimeAsync(RIDE_OUT_MS + RETRY_MAX_MS)
        await outcome
        // Every wait ended inside the window: no try starts after it.
        expect(ask.mock.calls.length).toBeGreaterThan(10)
        expect(ask.mock.calls.length).toBeLessThan(20)
    })

    it('stops asking when aborted', async () => {
        const controller = new AbortController()
        const ask = vi.fn().mockRejectedValue(apiError(503, 'PROVIDER_FAILING_OVER'))
        const asked = rideOut(ask, controller.signal)
        const outcome = expect(asked).rejects.toMatchObject({ status: 503 })
        await vi.advanceTimersByTimeAsync(500)
        controller.abort()
        await outcome
        expect(ask).toHaveBeenCalledTimes(1)
    })
})
