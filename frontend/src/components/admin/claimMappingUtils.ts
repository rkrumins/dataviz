/**
 * Pure helpers for the visual claim-mapping editor. Split out of the
 * component file so it exports components only (React Fast Refresh) and
 * so these stay directly unit-testable.
 */

/**
 * Keys an operator can map against: top level plus one level of
 * nesting. That matches how far the ``custom_profile`` provider hoists
 * nested containers before handing the claims to the mapper, so every
 * key listed here is genuinely reachable without a dotted path.
 */
export function detectKeys(sample: unknown): string[] {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return []
    const out = new Set<string>()
    for (const [k, v] of Object.entries(sample as Record<string, unknown>)) {
        out.add(k)
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const nested of Object.keys(v as Record<string, unknown>)) {
                out.add(nested)
            }
        }
    }
    return [...out].sort()
}

/**
 * Decode a pasted sample for display: a JWT's body, or plain JSON.
 *
 * No signature check happens here and none should — this previews what
 * the operator pasted so they can see its keys. Real verification is
 * server-side at login. Returns null when the input is neither.
 */
export function previewDecode(raw: string): unknown {
    const text = raw.trim()
    if (!text) return null
    const parts = text.split('.')
    if (parts.length === 3) {
        try {
            const body = parts[1].replace(/-/g, '+').replace(/_/g, '/')
            return JSON.parse(atob(body + '='.repeat((4 - body.length % 4) % 4)))
        } catch {
            // Not a JWT after all — fall through to the JSON attempt.
        }
    }
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

/** Normalise a mapping entry to the ordered candidate-key list the
 *  backend expects. Tolerates a bare string for hand-edited configs. */
export function asKeyList(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    if (typeof v === 'string' && v) return [v]
    return []
}

/** Pull the operator-defined ``extras`` block out of a mapping. */
export function extrasOf(
    mapping: Record<string, unknown>,
): Record<string, string[]> {
    const raw = mapping.extras
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>)
            .map(([k, v]) => [k, asKeyList(v)]),
    )
}
