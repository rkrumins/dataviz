/**
 * `React.lazy`, but able to survive a chunk that failed to arrive.
 *
 * Two things make the stock version brittle, and they compound:
 *
 * 1. **A failed dynamic import is permanent.** `React.lazy` memoises the
 *    promise it created, so once the import rejects, every subsequent
 *    render of that component re-throws the SAME rejection. The network
 *    can come back, the deploy can settle, the user can navigate away and
 *    return — the route stays broken until the whole document is
 *    reloaded. That is why "Failed to fetch dynamically imported module"
 *    is reported as *persistent* rather than as a blip.
 *
 * 2. **Nothing catches it.** The routes wrap each lazy element in
 *    `<Suspense>`, which handles the pending state and not the rejected
 *    one. With no error boundary above, the rejection unmounts the tree
 *    and the user gets a blank page.
 *
 * There are two distinct causes and they want different repairs:
 *
 *   * **The chunk is momentarily unreachable** — DNS lost on a VPN
 *     reconnect or a wake from sleep, which shows up as
 *     `ERR_NAME_NOT_RESOLVED` against every request in flight. Retrying
 *     fixes it, because the file still exists.
 *   * **The chunk is gone.** A deploy replaced the content-hashed
 *     bundles while this tab held the old `index.html`, so the names it
 *     is asking for 404 and will keep 404ing. Only fetching a fresh
 *     `index.html` fixes it, which means a real navigation.
 *
 * So: retry a few times with backoff, and if it still fails, reload once.
 * The reload is guarded by `sessionStorage` — an unconditional reload on
 * import failure is a reload loop when the network is simply down, which
 * is worse than the blank page it replaces.
 */
import { lazy, type ComponentType } from 'react'

/** Attempts before giving up on the network and suspecting a stale build. */
const MAX_ATTEMPTS = 3

/** Backoff between attempts. Short: a person is watching a spinner. */
const BACKOFF_MS = [250, 750]

/**
 * Marks that we have already reloaded for this failure. Cleared on any
 * successful import, so a later genuine deploy can still trigger one.
 *
 * `sessionStorage` rather than a module variable on purpose: the reload
 * destroys the module, so anything in memory is exactly the state that
 * cannot survive to prevent the second reload.
 */
const RELOAD_GUARD_KEY = 'nx:chunk-reload'

/** How long a reload marker suppresses another. Longer than a reload. */
const RELOAD_GUARD_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasReloadedRecently(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_GUARD_KEY)
    if (!raw) return false
    return Date.now() - Number(raw) < RELOAD_GUARD_MS
  } catch {
    // Private mode / storage disabled. Refusing to reload is the safe
    // side: a blank page the user can fix with F5 beats a reload loop
    // they cannot.
    return true
  }
}

function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
  } catch {
    /* see hasReloadedRecently */
  }
}

function clearReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_GUARD_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Wrap a dynamic import so a transient failure retries and a stale build
 * triggers exactly one reload.
 *
 * Usage is identical to `lazy`:
 *
 *     const LoginPage = lazyWithRetry(
 *       () => import('@/components/auth/LoginPage').then(m => ({ default: m.LoginPage })),
 *     )
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const mod = await factory()
        // Getting here means the build this tab is running is still
        // being served, so a future failure deserves its own reload.
        clearReloadGuard()
        return mod
      } catch (err) {
        lastError = err
        const backoff = BACKOFF_MS[attempt]
        if (backoff !== undefined) await sleep(backoff)
      }
    }

    // Out of attempts. Either the network is still down or this tab is
    // asking for chunks that no longer exist. A reload distinguishes
    // them: against a live server it picks up the new index.html and the
    // route works; against a dead network it fails the same way, which
    // is why it happens at most once.
    if (typeof window !== 'undefined' && !hasReloadedRecently()) {
      markReloaded()
      window.location.reload()
      // Never resolves — the document is going away. Returning a
      // rejected promise here would flash the error boundary first.
      await new Promise<never>(() => {})
    }

    throw lastError
  })
}
