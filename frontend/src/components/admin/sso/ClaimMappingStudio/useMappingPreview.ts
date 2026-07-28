/**
 * Resolve the mapping under edit, continuously.
 *
 * The old editor put this behind a Preview button that was *disabled until
 * the provider was saved* — so at the one moment an operator is actually
 * writing a mapping (the wizard's step 3, before the draft exists) it could
 * never run at all. Two changes fix that: the provider-less
 * `previewMapping` endpoint, and doing it without being asked.
 *
 * Debounced rather than per-keystroke, and skipped entirely when the sample
 * does not parse: an unparseable draft is the normal state halfway through
 * pasting, and firing a request for each character of it is noise, not
 * feedback.
 *
 * Errors are a *result* here, not a failure. "Could not resolve email" is
 * the single most useful thing this can tell an operator, so it lands in
 * `error` and renders inline rather than throwing.
 */
import { useEffect, useRef, useState } from 'react'
import {
    ssoAdminService,
    type IdpKind,
    type TestMappingResult,
} from '@/services/ssoAdminService'

export const PREVIEW_DEBOUNCE_MS = 350

export interface MappingPreview {
    result: TestMappingResult | null
    error: string | null
    /** True while a resolve is in flight, so the panes can dim rather than
     *  clear — clearing makes every keystroke flash an empty profile. */
    pending: boolean
}

export function useMappingPreview({
    kind, claims, mapping, providerId, slug,
}: {
    kind: IdpKind
    /** The decoded sample, or null when it does not parse yet. */
    claims: Record<string, unknown> | null
    mapping: Record<string, unknown>
    /** When present the saved-row endpoint is used, so a live provider
     *  previews against its own configuration. */
    providerId?: string
    slug?: string
}): MappingPreview {
    const [result, setResult] = useState<TestMappingResult | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState(false)

    // Only the newest resolve may write state. Without this a slow early
    // request can land after a fast later one and show a stale profile —
    // which, in a panel whose whole job is being trustworthy, is worse
    // than showing nothing.
    const seq = useRef(0)

    const claimsKey = claims ? JSON.stringify(claims) : ''
    const mappingKey = JSON.stringify(mapping)

    useEffect(() => {
        if (!claims) {
            setResult(null)
            setError(null)
            setPending(false)
            return
        }
        const ticket = ++seq.current
        setPending(true)
        const timer = setTimeout(() => {
            const call = providerId
                ? ssoAdminService.testMapping(providerId, claims, mapping)
                : ssoAdminService.previewMapping(kind, claims, mapping, slug)
            call.then(
                (r) => {
                    if (seq.current !== ticket) return
                    setResult(r)
                    setError(null)
                    setPending(false)
                },
                (err: Error) => {
                    if (seq.current !== ticket) return
                    setResult(null)
                    setError(err.message)
                    setPending(false)
                },
            )
        }, PREVIEW_DEBOUNCE_MS)
        return () => clearTimeout(timer)
        // claimsKey/mappingKey are the value-identity of the two objects;
        // depending on the objects themselves would re-run on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [claimsKey, mappingKey, kind, providerId, slug])

    return { result, error, pending }
}
