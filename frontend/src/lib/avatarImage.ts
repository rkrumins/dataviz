/**
 * The provider-supplied avatar image, addressed by user id.
 *
 * The server fetches the picture at SSO sign-in and re-serves it from
 * our own origin at this URL — the CSP forbids a remote image, so this
 * is the only src an ``<img>`` can load. Most users have no image, so
 * every surface that optimistically renders one would 404 per row per
 * mount; the negative cache remembers the misses (and the hits) for
 * the rest of the page load, pairing with the endpoint's own
 * ``Cache-Control`` for everything longer-lived.
 */

export function avatarImageSrc(userId: string): string {
    return `/api/v1/users/${encodeURIComponent(userId)}/avatar`
}

const known = new Map<string, 'ok' | 'none'>()

export function avatarImageState(userId: string): 'ok' | 'none' | undefined {
    return known.get(userId)
}

export function rememberAvatarImage(userId: string, state: 'ok' | 'none'): void {
    known.set(userId, state)
}

export function resetAvatarImageCacheForTests(): void {
    known.clear()
}
