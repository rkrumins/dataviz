/**
 * Visual claim-mapping editor.
 *
 * Replaces hand-writing the ``claim_mapping`` JSON. Each internal user
 * field gets an ordered list of candidate source keys — the backend's
 * mapper walks them in order and takes the first non-empty match
 * (``claim_mapper._first_non_empty``), so order is meaningful and the
 * UI preserves it.
 *
 * Three things make this usable rather than just prettier:
 *
 *   * **Defaults** are pulled from ``GET /admin/idp-providers/defaults/{kind}``
 *     so a fresh provider starts from the shapes we already handle.
 *   * **Detected keys** — paste (or read) a real payload and every key in
 *     it becomes a chip you can drop onto a field. This is the actual
 *     "map their fields to ours" interaction.
 *   * **Live preview** — ``POST /admin/idp-providers/{id}/test`` resolves
 *     the sample through the mapping being edited and shows what the
 *     user profile would look like, including the required-field errors.
 *
 * Output is the same ``claim_mapping`` JSON the backend already
 * consumes; nothing new on the wire.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Eye, Plus, RotateCcw, X } from 'lucide-react'
import {
    ssoAdminService,
    type IdpKind,
    type TestMappingResult,
} from '@/services/ssoAdminService'
import {
    asKeyList,
    detectKeys,
    extrasOf,
    previewDecode,
} from './claimMappingUtils'
import { cn } from '@/lib/utils'

export type ClaimMapping = Record<string, unknown>

/** The fields ``apply_claim_mapping`` reads, in the order an operator
 *  thinks about them. ``required`` mirrors the two the backend refuses
 *  to resolve without. */
const FIELDS: { key: string; label: string; hint: string; required?: boolean }[] = [
    { key: 'external_id', label: 'External ID', required: true,
      hint: 'Stable per-user identifier from the IdP. The durable join key — changing it orphans existing logins.' },
    { key: 'email', label: 'Email', required: true,
      hint: 'Lower-cased before use. Also drives account linking on collision.' },
    { key: 'email_verified', label: 'Email verified',
      hint: 'Boolean-ish. Strict linking policies refuse to auto-link when this is false.' },
    { key: 'first_name', label: 'First name', hint: '' },
    { key: 'last_name', label: 'Last name', hint: '' },
    { key: 'display_name', label: 'Full / display name',
      hint: 'Used only when first and last name are both empty — split on the first space.' },
    { key: 'groups', label: 'Groups',
      hint: 'Feeds the IdP-group → role / internal-group mappings. Accepts a list, or a comma-separated string.' },
    { key: 'auth_time', label: 'Auth time',
      hint: 'Epoch seconds. Drives the 24h SSO re-authentication ceiling.' },
]

// ── Chip list for one field ──────────────────────────────────────────

function KeyList({
    values, onChange, placeholder,
}: {
    values: string[]
    onChange: (next: string[]) => void
    placeholder: string
}) {
    const [draft, setDraft] = useState('')

    function add(raw: string) {
        const v = raw.trim()
        if (!v || values.includes(v)) { setDraft(''); return }
        onChange([...values, v])
        setDraft('')
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {values.map((v, i) => (
                <span
                    key={v}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[11px]"
                >
                    {/* Order is the fallback order the backend walks. */}
                    <span className="text-ink-muted">{i + 1}.</span>
                    {v}
                    <button
                        type="button"
                        aria-label={`Remove ${v}`}
                        onClick={() => onChange(values.filter((x) => x !== v))}
                        className="p-0.5 rounded hover:bg-white/10 text-ink-muted hover:text-ink"
                    >
                        <X className="w-3 h-3" />
                    </button>
                </span>
            ))}
            <input
                value={draft}
                placeholder={placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => add(draft)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault()
                        add(draft)
                    }
                }}
                className="min-w-[9rem] flex-1 px-2 py-0.5 rounded bg-canvas border border-white/10 font-mono text-[11px]"
            />
        </div>
    )
}

// ── Main editor ──────────────────────────────────────────────────────

export function ClaimMappingEditor({
    kind,
    providerId,
    value,
    onChange,
    onReadFromBrowser,
    initialSample,
}: {
    kind: IdpKind
    /** Present only for a saved provider — the live-preview endpoint is
     *  keyed by provider id, so preview is unavailable until first save. */
    providerId?: string
    value: ClaimMapping
    onChange: (next: ClaimMapping) => void
    /** Supplied by the custom_profile form: pulls the configured key out
     *  of the admin's own browser so they can map against the real
     *  object instead of a hand-typed sample. */
    onReadFromBrowser?: () => string | null
    /** A worked example to start from — the vendor preset's, in the setup
     *  wizard. Without one the preview has nothing to run on until a real
     *  sign-in has happened, so a first-time operator sees an empty result
     *  and cannot tell a good mapping from a bad one. */
    initialSample?: string
}) {
    const [defaults, setDefaults] = useState<ClaimMapping | null>(null)
    const [sample, setSample] = useState(initialSample ?? '')
    const [sampleError, setSampleError] = useState<string | null>(null)
    const [preview, setPreview] = useState<TestMappingResult | null>(null)
    const [previewError, setPreviewError] = useState<string | null>(null)
    const [previewing, setPreviewing] = useState(false)

    useEffect(() => {
        let cancelled = false
        ssoAdminService.getDefaultMapping(kind)
            .then((d) => { if (!cancelled) setDefaults(d) })
            .catch(() => { if (!cancelled) setDefaults({}) })
        return () => { cancelled = true }
    }, [kind])

    const extras = useMemo(() => extrasOf(value), [value])
    const parsedSample = useMemo(() => previewDecode(sample), [sample])
    const detected = useMemo(() => detectKeys(parsedSample), [parsedSample])

    // Three states per field, and they have to stay distinguishable:
    //   key absent  → inherit the kind default
    //   key present, empty list → deliberately map nothing
    //   key present, non-empty  → override
    // Writing the list verbatim (empty included) is what makes clearing
    // a defaulted field actually stick; ``revertField`` drops the key to
    // go back to inheriting.
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

    function usingDefault(field: string): boolean {
        return !(field in value)
    }

    function effective(field: string): string[] {
        return usingDefault(field)
            ? asKeyList(defaults?.[field])
            : asKeyList(value[field])
    }

    function readFromBrowser() {
        const raw = onReadFromBrowser?.()
        if (raw === null || raw === undefined) {
            setSampleError(
                'Nothing found under that key in this browser. Sign in to ' +
                'the portal in this tab first, or paste a sample below.',
            )
            return
        }
        setSampleError(null)
        setSample(raw)
    }

    /** The strongest sample available: what this provider actually sent on
     *  its last successful sign-in. Beats anything hand-typed. */
    async function loadLastAssertion() {
        if (!providerId) return
        setSampleError(null)
        try {
            const found = await ssoAdminService.lastAssertion(providerId)
            setSample(JSON.stringify(found.claims, null, 2))
        } catch {
            setSampleError(
                'No assertion captured yet. One is recorded on the next ' +
                'successful sign-in through this provider.',
            )
        }
    }

    async function runPreview() {
        if (!providerId) return
        if (!parsedSample || typeof parsedSample !== 'object') {
            setPreviewError('Paste a JSON object or a JWT to preview against.')
            setPreview(null)
            return
        }
        setPreviewing(true)
        setPreviewError(null)
        try {
            const result = await ssoAdminService.testMapping(
                providerId, parsedSample as Record<string, unknown>, value,
            )
            setPreview(result)
        } catch (err) {
            setPreview(null)
            setPreviewError((err as Error).message)
        } finally {
            setPreviewing(false)
        }
    }

    return (
        <div className="space-y-4 p-3 rounded-lg border border-white/10 bg-white/[0.02]">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h4 className="text-xs font-semibold text-ink">Profile field mapping</h4>
                    <p className="mt-0.5 text-[11px] text-ink-muted">
                        Which key from the identity provider fills each of our
                        fields. Listed in fallback order — the first key that
                        has a value wins. Leave a row empty to use the default.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onChange({})}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 text-[11px] text-ink-muted hover:bg-white/5"
                >
                    <RotateCcw className="w-3 h-3" /> Reset to defaults
                </button>
            </div>

            {/* ── Field rows ── */}
            <div className="space-y-2">
                {FIELDS.map((f) => (
                    <div key={f.key} className="grid grid-cols-[10rem_1fr] gap-3 items-start">
                        <div className="pt-1">
                            <div className="text-[11px] font-medium text-ink">
                                {f.label}
                                {f.required && <span className="ml-1 text-red-400" title="Required">*</span>}
                            </div>
                            {usingDefault(f.key) ? (
                                <div className="text-[10px] text-ink-muted">using default</div>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => revertField(f.key)}
                                    className="text-[10px] text-accent-lineage hover:underline"
                                >
                                    use default
                                </button>
                            )}
                            {!usingDefault(f.key) && effective(f.key).length === 0 && (
                                <div className="text-[10px] text-yellow-400">
                                    not mapped
                                </div>
                            )}
                        </div>
                        <div>
                            <KeyList
                                values={effective(f.key)}
                                onChange={(next) => setField(f.key, next)}
                                placeholder="add a key…"
                            />
                            {f.hint && (
                                <p className="mt-1 text-[10px] text-ink-muted">{f.hint}</p>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* ── Extra attributes ── */}
            <ExtrasEditor extras={extras} onChange={setExtras} />

            {/* ── Sample payload + detected keys ── */}
            <div className="pt-3 border-t border-white/10 space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <label className="text-[11px] font-medium text-ink">
                        Sample payload
                    </label>
                    <div className="flex gap-2">
                        {providerId && (
                            <button
                                type="button"
                                onClick={() => { void loadLastAssertion() }}
                                title="Load the most recent claims this provider actually sent"
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 text-[11px] text-ink-muted hover:bg-white/5"
                            >
                                Load last assertion
                            </button>
                        )}
                        {onReadFromBrowser && (
                            <button
                                type="button"
                                onClick={readFromBrowser}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 text-[11px] text-ink-muted hover:bg-white/5"
                            >
                                Read from my browser
                            </button>
                        )}
                        <button
                            type="button"
                            disabled={!providerId || previewing}
                            title={providerId
                                ? 'Resolve this sample through the mapping above'
                                : 'Save the provider first — preview runs server-side against the saved row'}
                            onClick={() => { void runPreview() }}
                            className={cn(
                                "inline-flex items-center gap-1 px-2 py-1 rounded border text-[11px]",
                                providerId && !previewing
                                    ? "border-accent-lineage/40 text-accent-lineage hover:bg-accent-lineage/10"
                                    : "border-white/10 text-ink-muted opacity-60 cursor-not-allowed",
                            )}
                        >
                            <Eye className="w-3 h-3" /> Preview
                        </button>
                    </div>
                </div>
                <textarea
                    rows={4}
                    value={sample}
                    onChange={(e) => { setSample(e.target.value); setSampleError(null) }}
                    placeholder='{"employeeId": "12345", "emailAddress": "a@corp.example", "fullName": "Alice Doe"}  — or a JWT'
                    className="w-full px-2 py-1.5 rounded bg-canvas border border-white/10 font-mono text-[11px]"
                />
                {sampleError && (
                    <p className="text-[11px] text-yellow-300">{sampleError}</p>
                )}
                {detected.length > 0 && (
                    <div>
                        <p className="text-[10px] text-ink-muted mb-1">
                            Keys found in the sample — click one to copy it, then
                            paste into a field above:
                        </p>
                        <div className="flex flex-wrap gap-1">
                            {detected.map((k) => (
                                <button
                                    key={k}
                                    type="button"
                                    onClick={() => { void navigator.clipboard?.writeText(k) }}
                                    className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px] hover:bg-white/10"
                                >
                                    {k}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>

            {/* ── Preview result ── */}
            {previewError && (
                <p className="text-[11px] text-red-400">{previewError}</p>
            )}
            {preview && (
                <div className="p-2 rounded border border-green-500/20 bg-green-500/5 space-y-1">
                    <div className="flex items-center gap-1 text-[11px] font-medium text-green-400">
                        <Check className="w-3 h-3" /> Resolved profile
                    </div>
                    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 text-[11px]">
                        <dt className="text-ink-muted">External ID</dt>
                        <dd className="font-mono">{preview.resolved.external_id}</dd>
                        <dt className="text-ink-muted">Email</dt>
                        <dd className="font-mono">{preview.resolved.email}</dd>
                        <dt className="text-ink-muted">First name</dt>
                        <dd className="font-mono">{preview.resolved.first_name || '—'}</dd>
                        <dt className="text-ink-muted">Last name</dt>
                        <dd className="font-mono">{preview.resolved.last_name || '—'}</dd>
                        <dt className="text-ink-muted">Groups</dt>
                        <dd className="font-mono">
                            {preview.resolved.groups.length
                                ? preview.resolved.groups.join(', ')
                                : '—'}
                        </dd>
                        <dt className="text-ink-muted">Attributes</dt>
                        <dd className="font-mono">
                            {Object.keys(preview.resolved.attributes).length
                                ? JSON.stringify(preview.resolved.attributes)
                                : '—'}
                        </dd>
                    </dl>
                </div>
            )}
        </div>
    )
}

// ── Extras sub-editor ────────────────────────────────────────────────

function ExtrasEditor({
    extras, onChange,
}: {
    extras: Record<string, string[]>
    onChange: (next: Record<string, string[]>) => void
}) {
    const [newKey, setNewKey] = useState('')
    const rows = Object.entries(extras)

    function rename(from: string, to: string) {
        const trimmed = to.trim()
        if (!trimmed || trimmed === from || trimmed in extras) return
        const next: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(extras)) next[k === from ? trimmed : k] = v
        onChange(next)
    }

    return (
        <div className="pt-3 border-t border-white/10 space-y-2">
            <div>
                <h5 className="text-[11px] font-medium text-ink">Extra attributes</h5>
                <p className="text-[10px] text-ink-muted">
                    Anything else worth keeping — department, employee ID, cost
                    centre. Stored on the user and indexed, so admins can find
                    people by these values. Never used for access decisions.
                </p>
            </div>

            {rows.map(([key, candidates]) => (
                <div key={key} className="grid grid-cols-[10rem_1fr_auto] gap-2 items-start">
                    <input
                        defaultValue={key}
                        onBlur={(e) => rename(key, e.target.value)}
                        aria-label="Attribute name"
                        className="px-2 py-1 rounded bg-canvas border border-white/10 font-mono text-[11px]"
                    />
                    <KeyList
                        values={candidates}
                        onChange={(next) => onChange({ ...extras, [key]: next })}
                        placeholder="source key…"
                    />
                    <button
                        type="button"
                        aria-label={`Remove attribute ${key}`}
                        onClick={() => {
                            const next = { ...extras }
                            delete next[key]
                            onChange(next)
                        }}
                        className="p-1 rounded text-ink-muted hover:bg-white/10 hover:text-ink"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ))}

            <div className="flex gap-2">
                <input
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="new attribute name, e.g. staff_id"
                    aria-label="New attribute name"
                    className="flex-1 px-2 py-1 rounded bg-canvas border border-white/10 font-mono text-[11px]"
                />
                <button
                    type="button"
                    onClick={() => {
                        const k = newKey.trim()
                        if (!k || k in extras) return
                        onChange({ ...extras, [k]: [] })
                        setNewKey('')
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 text-[11px] text-ink-muted hover:bg-white/5"
                >
                    <Plus className="w-3 h-3" /> Add
                </button>
            </div>
        </div>
    )
}
