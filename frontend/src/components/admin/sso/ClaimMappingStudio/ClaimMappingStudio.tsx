/**
 * Claim mapping, as two panes that refer to each other.
 *
 * Replaces `ClaimMappingEditor`, which had all the same capability laid out
 * as a vertical form: eight rows of chips, then an extras block, then a
 * textarea, then a disabled Preview button, then — if you had saved the
 * provider first — a small `<dl>` of results. The relationship the screen
 * exists to show ("their key → our field → this value") was spread over
 * four screens of scroll and one button press.
 *
 * Now: their payload on the left, our profile on the right, resolved
 * continuously against the real backend mapper. Clicking a key on the left
 * assigns it on the right; the right says which key won and which
 * candidates never fire.
 *
 * Output is unchanged — the same `claim_mapping` JSON, with the same
 * three-state semantics per field that the backend merge depends on:
 *
 *   key absent               inherit the kind default
 *   key present, empty list  deliberately map nothing
 *   key present, non-empty   override
 *
 * That distinction is why `setField` writes the list verbatim (empty
 * included) and `revertField` deletes the key instead of writing `[]`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { RotateCcw, Code2 } from 'lucide-react'
import {
    ssoAdminService,
    type IdpKind,
} from '@/services/ssoAdminService'
import {
    asKeyList, detectKeys, extrasOf, previewDecode,
} from '../../claimMappingUtils'
import { FIELDS } from './fields'
import { PayloadPane, summarise, type PayloadKey, type KeyState } from './PayloadPane'
import { ProfilePane, type FieldRow } from './ProfilePane'
import { SampleSourceBar, type SampleSource } from './SampleSourceBar'
import { ExtrasEditor } from './ExtrasEditor'
import { useMappingPreview } from './useMappingPreview'

export type ClaimMapping = Record<string, unknown>

export function ClaimMappingStudio({
    kind, providerId, slug, value, onChange, onReadFromBrowser,
    initialSample, initialSampleSource = 'example',
}: {
    kind: IdpKind
    /** Present for a saved provider — preview then runs against its row. */
    providerId?: string
    slug?: string
    value: ClaimMapping
    onChange: (next: ClaimMapping) => void
    /** Supplied by the custom_profile form for a storage-backed source:
     *  pulls the configured key out of the admin's own browser. */
    onReadFromBrowser?: () => string | null
    /** A worked example to start from — the vendor preset's, in the wizard. */
    initialSample?: string
    initialSampleSource?: SampleSource
}) {
    const [defaults, setDefaults] = useState<ClaimMapping | null>(null)
    const [sample, setSample] = useState(initialSample ?? '')
    const [source, setSource] = useState<SampleSource>(
        initialSample ? initialSampleSource : 'pasted',
    )
    const [capturedAt, setCapturedAt] = useState<string | null>(null)
    const [note, setNote] = useState<string | null>(null)
    const [loadingSample, setLoadingSample] = useState(false)
    const [showRaw, setShowRaw] = useState(false)

    useEffect(() => {
        let cancelled = false
        ssoAdminService.getDefaultMapping(kind)
            .then(d => { if (!cancelled) setDefaults(d) })
            .catch(() => { if (!cancelled) setDefaults({}) })
        return () => { cancelled = true }
    }, [kind])

    const extras = useMemo(() => extrasOf(value), [value])
    const parsed = useMemo(() => previewDecode(sample), [sample])
    const claims = useMemo(
        () => (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null),
        [parsed],
    )

    const { result, error, pending } = useMappingPreview({
        kind, claims, mapping: value, providerId, slug,
    })

    const usingDefault = useCallback(
        (field: string) => !(field in value), [value],
    )
    const effective = useCallback(
        (field: string) => (usingDefault(field)
            ? asKeyList(defaults?.[field])
            : asKeyList(value[field])),
        [defaults, value, usingDefault],
    )

    const setField = useCallback((field: string, next: string[]) => {
        onChange({ ...value, [field]: next })
    }, [value, onChange])

    const revertField = useCallback((field: string) => {
        const out = { ...value }
        delete out[field]
        onChange(out)
    }, [value, onChange])

    const setExtras = useCallback((next: Record<string, string[]>) => {
        const out = { ...value }
        if (Object.keys(next).length) out.extras = next
        else delete out.extras
        onChange(out)
    }, [value, onChange])

    /** Assigning appends rather than replaces: the list is a fallback
     *  chain, and an operator clicking a second key for the same field
     *  almost always means "and also try this one". */
    const assign = useCallback((path: string, field: string) => {
        const current = effective(field)
        if (current.includes(path)) return
        setField(field, [...current, path])
    }, [effective, setField])

    const keepAsExtra = useCallback((path: string) => {
        if (path in extras) return
        setExtras({ ...extras, [path]: [path] })
    }, [extras, setExtras])

    // ── Sample loading ───────────────────────────────────────────────

    function readFromBrowser() {
        const raw = onReadFromBrowser?.()
        if (raw === null || raw === undefined) {
            setNote(
                'Nothing found under that key in this browser. Sign in to ' +
                'the portal in this tab first, or paste a sample below.',
            )
            return
        }
        setNote(null)
        setSample(raw)
        setSource('browser')
    }

    async function loadLastAssertion() {
        if (!providerId) return
        setNote(null)
        setLoadingSample(true)
        try {
            const found = await ssoAdminService.lastAssertion(providerId)
            setSample(JSON.stringify(found.claims, null, 2))
            setCapturedAt(found.capturedAt)
            setSource('assertion')
        } catch {
            setNote(
                'No assertion captured yet. One is recorded on the next ' +
                'successful sign-in through this provider.',
            )
        } finally {
            setLoadingSample(false)
        }
    }

    // ── Derived view models ──────────────────────────────────────────

    const resolvedFrom = result?.resolvedFrom

    /** Every key in the sample, with what currently reads it. */
    const payloadKeys: PayloadKey[] = useMemo(() => {
        if (!claims) return []
        // Which field, if any, lists this key — and whether it is the one
        // that actually fires. Both come from the same candidate lists the
        // backend merged, so the two panes cannot disagree.
        const owner = new Map<string, KeyState>()
        for (const f of FIELDS) {
            for (const cand of effective(f.key)) {
                if (owner.has(cand)) continue
                const won = resolvedFrom
                    ? resolvedFrom[f.key] === cand
                    : effective(f.key)[0] === cand
                owner.set(cand, won
                    ? { kind: 'mapped', field: f.key }
                    : { kind: 'shadowed', field: f.key })
            }
        }
        for (const [name, cands] of Object.entries(extras)) {
            for (const cand of cands) {
                if (!owner.has(cand)) {
                    owner.set(cand, { kind: 'mapped', field: `extras.${name}` })
                }
            }
        }
        return detectKeys(claims).map(path => ({
            path,
            preview: summarise(resolveForDisplay(claims, path)),
            state: owner.get(path) ?? { kind: 'unmapped' },
        }))
    }, [claims, effective, extras, resolvedFrom])

    const rows: FieldRow[] = useMemo(() => FIELDS.map(f => ({
        key: f.key,
        label: f.label,
        hint: f.hint,
        required: f.required,
        candidates: effective(f.key),
        inherited: usingDefault(f.key),
        winner: resolvedFrom ? resolvedFrom[f.key] ?? null : undefined,
        value: result ? displayValue(result.resolved, f.key) : undefined,
    })), [effective, usingDefault, resolvedFrom, result])

    return (
        <div className="space-y-4">
            <div className="flex items-start justify-between gap-3">
                <SampleSourceBar
                    source={source}
                    capturedAt={capturedAt}
                    canLoadAssertion={Boolean(providerId)}
                    canReadBrowser={Boolean(onReadFromBrowser)}
                    onLoadAssertion={() => { void loadLastAssertion() }}
                    onReadBrowser={readFromBrowser}
                    loading={loadingSample}
                    note={note}
                />
                <button
                    type="button"
                    onClick={() => onChange({})}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-black/[0.10] dark:border-white/[0.12] text-[11px] text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                    <RotateCcw className="w-3 h-3" /> Reset to defaults
                </button>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                <PayloadPane
                    keys={payloadKeys}
                    onAssign={assign}
                    onAddExtra={keepAsExtra}
                    empty={sample.trim()
                        ? 'That is not JSON or a JWT yet — nothing to read keys from.'
                        : 'Paste a payload below, or load a real assertion.'}
                />
                <ProfilePane
                    rows={rows}
                    pending={pending}
                    error={error}
                    onRemoveCandidate={(field, key) =>
                        setField(field, effective(field).filter(k => k !== key))}
                    onAddCandidate={(field, key) => {
                        const cur = effective(field)
                        if (!cur.includes(key)) setField(field, [...cur, key])
                    }}
                    onRevert={revertField}
                />
            </div>

            <ExtrasEditor extras={extras} onChange={setExtras} />

            <div className="pt-3 border-t border-black/[0.08] dark:border-white/[0.10]">
                <button
                    type="button"
                    onClick={() => setShowRaw(s => !s)}
                    aria-expanded={showRaw}
                    className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink"
                >
                    <Code2 className="w-3 h-3" />
                    {showRaw ? 'Hide raw payload' : 'Edit raw payload'}
                </button>
                {showRaw && (
                    <textarea
                        rows={6}
                        value={sample}
                        onChange={e => {
                            setSample(e.target.value)
                            setSource('pasted')
                            setCapturedAt(null)
                            setNote(null)
                        }}
                        placeholder='{"employeeId": "12345", "emailAddress": "a@corp.example", "fullName": "Alice Doe"}  — or a JWT'
                        className="mt-2 w-full px-3 py-2 rounded-xl bg-canvas border border-black/[0.10] dark:border-white/[0.12] font-mono text-[11px]"
                    />
                )}
            </div>
        </div>
    )
}

/** Walk a detected key for display. `detectKeys` surfaces one level of
 *  nesting by bare name, so a nested key is looked up by scanning — the
 *  same reachability the custom_profile provider gives it server-side. */
function resolveForDisplay(claims: Record<string, unknown>, path: string): unknown {
    if (path in claims) return claims[path]
    for (const v of Object.values(claims)) {
        if (v && typeof v === 'object' && !Array.isArray(v)
            && path in (v as Record<string, unknown>)) {
            return (v as Record<string, unknown>)[path]
        }
    }
    return undefined
}

function displayValue(
    resolved: {
        external_id: string; email: string; first_name: string
        last_name: string; groups: string[]; auth_time: number | null
        attributes: Record<string, unknown>
    },
    field: string,
): string | undefined {
    switch (field) {
        case 'external_id': return resolved.external_id
        case 'email': return resolved.email
        case 'first_name': return resolved.first_name
        case 'last_name': return resolved.last_name
        case 'groups': return resolved.groups.join(', ')
        case 'auth_time':
            return resolved.auth_time === null ? '' : String(resolved.auth_time)
        // The mapper folds display_name into first/last and email_verified
        // into a boolean it does not echo, so neither has a resolved value
        // of its own to show. Provenance still says which key was read.
        default: return undefined
    }
}
