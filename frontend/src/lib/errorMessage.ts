/**
 * Extract a user-readable string from a backend error body.
 *
 * Why this exists:
 *   FastAPI's ``detail`` field is polymorphic — it can be a string, a
 *   FastAPI 422 validation array, or a structured object like the
 *   permission-error envelope used by ``requires(...)``:
 *
 *     { detail: { error, permission, scope, message } }
 *
 *   Every service module that throws on ``!res.ok`` MUST extract the
 *   right string from these three shapes. The naïve
 *   ``detail = body.detail || JSON.stringify(body)`` pattern collapses
 *   the structured object into the falsy check (an object is truthy),
 *   then ``new Error(object)`` coerces via ``Object.prototype.toString``
 *   and the user sees ``"[object Object]"`` in their toast.
 *
 *   Centralising the extraction here means every service uses the same
 *   correct shape and any future ``detail`` schema gets one place to
 *   teach.
 *
 * Returns the most human-friendly string available:
 *   1. ``detail`` is a string → return it.
 *   2. ``detail`` is an array (FastAPI validation) → first ``msg`` or
 *      JSON dump.
 *   3. ``detail`` is an object → ``message`` field if present, else
 *      JSON dump.
 *   4. No ``detail`` → JSON dump of the whole body.
 *   5. Body wasn't JSON → return ``fallback``.
 */
export function extractErrorMessage(
    body: unknown,
    fallback: string,
): string {
    if (body === null || body === undefined) return fallback
    if (typeof body === 'string') return body || fallback
    if (typeof body !== 'object') return String(body)

    const detail = (body as { detail?: unknown }).detail

    if (typeof detail === 'string' && detail.length > 0) {
        return detail
    }

    if (Array.isArray(detail)) {
        const first = detail.find(
            (e): e is { msg: string } =>
                !!e && typeof e === 'object' && typeof (e as { msg?: unknown }).msg === 'string',
        )
        if (first) return first.msg
        try {
            return JSON.stringify(detail)
        } catch {
            return fallback
        }
    }

    if (detail && typeof detail === 'object') {
        const message = (detail as { message?: unknown }).message
        if (typeof message === 'string' && message.length > 0) {
            return message
        }
        try {
            return JSON.stringify(detail)
        } catch {
            return fallback
        }
    }

    // No ``detail`` at all; dump the body so the developer can see
    // what the backend actually returned.
    try {
        return JSON.stringify(body)
    } catch {
        return fallback
    }
}


/** Parse a raw response body (text) into a friendly error string.
 *  Wraps ``extractErrorMessage`` with the JSON.parse boilerplate so
 *  service-layer call sites stay one-liners. */
export function extractErrorMessageFromText(
    text: string | null | undefined,
    fallback: string,
): string {
    if (!text) return fallback
    try {
        return extractErrorMessage(JSON.parse(text), fallback)
    } catch {
        // Body wasn't JSON — the raw text is the most useful we have.
        return text
    }
}
