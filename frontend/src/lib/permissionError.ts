/**
 * Parse anything a service might throw or return into a structured
 * description of an access-denied condition. Lets the FE render a
 * polished notice instead of dumping `JSON.stringify(detail)` to the
 * user.
 *
 * Backend 403s carry a structured detail:
 *   { detail: {
 *       error: "missing_permission",
 *       permission: "system:admin",
 *       scope:    { type: "global" | "workspace", id: string | null },
 *       message:  "Missing permission: system:admin"
 *   } }
 *
 * Some service modules pass the raw response text into Error.message
 * verbatim (e.g. `insightsAdminService`), so the same payload can land
 * here as:
 *   - an Error whose .message is the JSON envelope
 *   - an Error whose .message is the unwrapped detail (object stringified)
 *   - an Error whose .message is just the human "Missing permission: X"
 *   - a structured object passed straight in (rare, but cheap to support)
 *   - a string (notification handler, generic catch-all)
 *
 * The parser canonicalises all of these into a single shape — or
 * returns null when the input isn't a permission denial, letting
 * callers fall through to their existing generic error rendering.
 */

export interface ParsedPermissionError {
    /** Backend code, e.g. ``missing_permission``. */
    code: string
    /** The permission string the user lacks. */
    permission: string
    /** Optional scope (workspace_id when present, else global). */
    scope: { type: 'global' | 'workspace'; id: string | null } | null
    /** Human-friendly message — backend supplies one; we fall back to a
     *  generated phrasing when it's missing. */
    message: string
}

interface PermissionDetailLike {
    error?: string
    permission?: string
    scope?: { type?: string; id?: string | null } | null
    message?: string
    detail?: PermissionDetailLike
}

const PERMISSION_ERROR_CODES = new Set([
    'missing_permission',
    'access_denied',
    'forbidden',
])

function isPermissionDetail(v: unknown): v is PermissionDetailLike {
    if (!v || typeof v !== 'object') return false
    const obj = v as Record<string, unknown>
    if (typeof obj.permission === 'string') return true
    if (typeof obj.error === 'string' && PERMISSION_ERROR_CODES.has(obj.error)) {
        return true
    }
    return false
}

function fromDetail(detail: PermissionDetailLike): ParsedPermissionError | null {
    // The backend sometimes wraps payloads as ``{detail: {...}}`` and
    // sometimes inline. Tolerate both.
    if (detail.detail) {
        const inner = fromDetail(detail.detail)
        if (inner) return inner
    }
    if (!isPermissionDetail(detail)) return null
    const permission = detail.permission ?? 'unknown'
    const scope =
        detail.scope && typeof detail.scope === 'object'
            ? {
                  type: (detail.scope.type === 'workspace' ? 'workspace' : 'global') as
                      | 'global'
                      | 'workspace',
                  id: detail.scope.id ?? null,
              }
            : null
    return {
        code: detail.error ?? 'missing_permission',
        permission,
        scope,
        message: detail.message ?? `Missing permission: ${permission}`,
    }
}

/** Try to JSON-parse a string; return null on failure. Tolerates the
 *  common case where the whole response body got concatenated as the
 *  Error message. */
function tryParseJson(s: string): unknown {
    try {
        return JSON.parse(s)
    } catch {
        return null
    }
}

/** Heuristic fallback: messages like ``Missing permission: system:admin``
 *  are explicitly emitted by the backend even when the structured
 *  envelope was lost in translation. Recognise them so the UI still
 *  renders the polished notice. */
const MISSING_PERMISSION_RE = /^missing permission:\s*([a-zA-Z0-9_:.\-*]+)/i

export function parsePermissionError(input: unknown): ParsedPermissionError | null {
    if (input == null) return null

    // 1. Plain Error → recurse into .message.
    if (input instanceof Error) {
        return parsePermissionError(input.message)
    }

    // 2. Structured object passed directly.
    if (typeof input === 'object') {
        return fromDetail(input as PermissionDetailLike)
    }

    if (typeof input !== 'string') return null
    const trimmed = input.trim()
    if (!trimmed) return null

    // 3. JSON envelope dumped as a string (the common offender —
    //    e.g. insightsAdminService throws `new Error(text)` directly).
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = tryParseJson(trimmed)
        if (parsed && typeof parsed === 'object') {
            const fromObj = fromDetail(parsed as PermissionDetailLike)
            if (fromObj) return fromObj
        }
    }

    // 4. Pattern match the canonical phrasing.
    const m = MISSING_PERMISSION_RE.exec(trimmed)
    if (m) {
        return {
            code: 'missing_permission',
            permission: m[1],
            scope: null,
            message: trimmed,
        }
    }

    return null
}

/** Strip the JSON envelope from a stringified error if there is one,
 *  returning the cleanest human-friendly message available. Useful for
 *  callers that don't show a polished notice but still want to avoid
 *  rendering raw JSON. */
export function humanizeErrorMessage(input: unknown): string {
    const parsed = parsePermissionError(input)
    if (parsed) return parsed.message
    if (input instanceof Error) return input.message || 'Something went wrong'
    if (typeof input === 'string') {
        const trimmed = input.trim()
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            const parsedRaw = tryParseJson(trimmed)
            if (parsedRaw && typeof parsedRaw === 'object') {
                const obj = parsedRaw as { detail?: unknown; message?: unknown }
                const detail = obj.detail
                if (typeof detail === 'string') return detail
                if (detail && typeof detail === 'object') {
                    const d = detail as { message?: unknown }
                    if (typeof d.message === 'string') return d.message
                }
                if (typeof obj.message === 'string') return obj.message
            }
        }
        return trimmed || 'Something went wrong'
    }
    return 'Something went wrong'
}
