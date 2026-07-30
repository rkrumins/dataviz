/**
 * A chunk that fails to download must not kill the route permanently.
 *
 * `React.lazy` memoises the promise it created, so a single rejected
 * import re-throws the same rejection on every later render — the network
 * can recover and the route stays broken for the life of the tab. That is
 * what turns a momentary `ERR_NAME_NOT_RESOLVED` into "Failed to fetch
 * dynamically imported module" reported as a persistent error.
 *
 * These drive the factory the way React does — call the loader, see what
 * it resolves — rather than rendering, because the behaviour under test
 * is entirely in the import wrapper.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { lazyWithRetry } from './lazyWithRetry'

/** Pull the loader React would call out of the lazy component. */
function loaderOf(component: unknown): () => Promise<{ default: unknown }> {
    return (component as { _payload: { _result: () => Promise<{ default: unknown }> } })
        ._payload._result
}

const Dummy = (() => null) as unknown as React.ComponentType<unknown>

beforeEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
})

describe('lazyWithRetry', () => {
    it('recovers when the chunk arrives on a later attempt', async () => {
        // The shape of a VPN reconnect: the file exists, the lookup did
        // not. Stock lazy() would cache this rejection forever.
        const factory = vi
            .fn<() => Promise<{ default: React.ComponentType<unknown> }>>()
            .mockRejectedValueOnce(
                new TypeError('Failed to fetch dynamically imported module'),
            )
            .mockResolvedValue({ default: Dummy })

        const mod = await loaderOf(lazyWithRetry(factory))()

        expect(mod.default).toBe(Dummy)
        expect(factory).toHaveBeenCalledTimes(2)
    })

    it('reloads once when the chunk is gone for good', async () => {
        // A deploy replaced the hashed bundles while this tab held the
        // old index.html. Retrying cannot help — only a fresh document
        // knows the new names.
        const reload = vi.fn()
        vi.stubGlobal('location', { ...window.location, reload })

        const factory = vi
            .fn<() => Promise<{ default: React.ComponentType<unknown> }>>()
            .mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'))

        const loader = loaderOf(lazyWithRetry(factory))
        // Never settles: the document is being replaced.
        void loader()
        // Comfortably past the retry budget (250ms + 750ms of backoff);
        // vi.waitFor's 1s default races it exactly.
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), {
            timeout: 4_000,
        })

        expect(factory.mock.calls.length).toBeGreaterThan(1)
    })

    it('does not reload twice, so a dead network cannot loop', async () => {
        // The guard that makes the reload safe. Without it, a client that
        // is simply offline reloads, fails to load anything, reloads
        // again — a loop the user cannot escape, which is strictly worse
        // than the blank page it was meant to replace.
        const reload = vi.fn()
        vi.stubGlobal('location', { ...window.location, reload })

        const factory = vi
            .fn<() => Promise<{ default: React.ComponentType<unknown> }>>()
            .mockRejectedValue(new TypeError('Failed to fetch dynamically imported module'))

        void loaderOf(lazyWithRetry(factory))()
        // Comfortably past the retry budget (250ms + 750ms of backoff);
        // vi.waitFor's 1s default races it exactly.
        await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), {
            timeout: 4_000,
        })

        // The reload marker survives in sessionStorage, exactly as it
        // would across the real navigation.
        await expect(loaderOf(lazyWithRetry(factory))()).rejects.toThrow(
            /dynamically imported module/,
        )
        expect(reload).toHaveBeenCalledTimes(1)
    })

    it('clears the guard on success so a later deploy still reloads', async () => {
        sessionStorage.setItem('nx:chunk-reload', String(Date.now()))
        const factory = vi
            .fn<() => Promise<{ default: React.ComponentType<unknown> }>>()
            .mockResolvedValue({ default: Dummy })

        await loaderOf(lazyWithRetry(factory))()

        expect(sessionStorage.getItem('nx:chunk-reload')).toBeNull()
    })

    it('does not retry a successful import', async () => {
        const factory = vi
            .fn<() => Promise<{ default: React.ComponentType<unknown> }>>()
            .mockResolvedValue({ default: Dummy })

        await loaderOf(lazyWithRetry(factory))()

        expect(factory).toHaveBeenCalledTimes(1)
    })
})
