/**
 * Same-origin relative paths only — the client half of the backend's
 * ``_safe_next`` open-redirect guard (``auth_service/api/router.py``).
 *
 * Anywhere we take a destination from the URL and then navigate to it, an
 * attacker gets to choose that destination. ``//evil.example`` is the one
 * that catches people out: it starts with a slash, so a naive
 * ``startsWith('/')`` check passes it, and the browser reads it as a
 * protocol-relative absolute URL.
 *
 * Shared rather than copied because it was already written twice and a
 * guard that exists in two places is a guard that will be fixed in one.
 */

/** A relative, same-origin path, or *fallback* if the input isn't one. */
export function safeNext(raw: string | null | undefined, fallback = '/'): string {
    if (!raw) return fallback
    // Reject protocol-relative ("//host") and scheme-bearing ("https://",
    // "javascript:") forms; require a rooted path.
    if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
    // A backslash after the leading slash is normalised to a forward
    // slash by some browsers, which turns "/\evil.example" into a
    // protocol-relative URL after the check above has passed it.
    if (raw.startsWith('/\\')) return fallback
    return raw
}
