/**
 * The provider-supplied avatar image, addressed by user id.
 *
 * The server fetches the picture at SSO sign-in and re-serves it from
 * our own origin at this URL — the CSP forbids a remote image, so this
 * is the only src an ``<img>`` can load. Most users have no image, so
 * every surface that optimistically renders one would 404 per row per
 * mount; the negative cache remembers the misses (and the hits),
 * pairing with the endpoint's own ``Cache-Control`` for everything
 * longer-lived.
 *
 * Two rules keep "no picture yet" from becoming "no picture until a
 * hard refresh":
 *
 * * a MISS is provisional — it expires after the same 60s the endpoint
 *   lets a browser cache the 404, so a picture stored mid-session is
 *   at most a minute from appearing on freshly mounted surfaces;
 * * a successful sign-in calls :func:`bumpAvatarCache`, which clears
 *   the misses AND versions the URL — sign-in is exactly when the
 *   server may have just stored the image, and the new query string is
 *   what gets past the browser's still-cached 404.
 */

//: How long a remembered miss stands before one retry is allowed.
//: Matches the endpoint's 404 ``max-age`` — retrying sooner would only
//: re-read the browser's cached 404.
const MISS_TTL_MS = 60_000

let version = 0
const known = new Map<string, { state: 'ok' | 'none'; at: number }>()

export function avatarImageSrc(userId: string): string {
    const base = `/api/v1/users/${encodeURIComponent(userId)}/avatar`
    return version > 0 ? `${base}?v=${version}` : base
}

export function avatarImageState(userId: string): 'ok' | 'none' | undefined {
    const entry = known.get(userId)
    if (!entry) return undefined
    if (entry.state === 'none' && Date.now() - entry.at > MISS_TTL_MS) {
        known.delete(userId)
        return undefined
    }
    return entry.state
}

export function rememberAvatarImage(userId: string, state: 'ok' | 'none'): void {
    known.set(userId, { state, at: Date.now() })
}

/**
 * Forget every remembered miss and version the image URLs.
 *
 * Called after each successful sign-in (the auth store's fresh-login
 * paths — never bootstrap, which runs on every load and would defeat
 * the endpoint's caching for no reason).
 */
export function bumpAvatarCache(): void {
    known.clear()
    version += 1
}

export function resetAvatarImageCacheForTests(): void {
    known.clear()
    version = 0
}
