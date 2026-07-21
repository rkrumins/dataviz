/**
 * Node Identity Property (URN-equivalent) — shared, premium, cross-surface UI.
 *
 * The platform keys every node on a canonical `urn`. Onboarded third-party
 * graphs often identify nodes by another property (`id`, `name`, …) and carry
 * no `urn`; this control lets an operator declare that URN-equivalent per data
 * source, resolved at read time as `coalesce(n.urn, n.<property>)` — no graph
 * rewrite. Frozen onto the next aggregation run.
 *
 * ONE source of truth for every surface that shows or edits it:
 *  - <NodeIdentityField/>  — the editable expert disclosure (detail panel,
 *    ingestion form, onboarding/attach wizards).
 *  - <NodeIdentityBadge/>  — the read-only "mapped" chip (grid cards, headers).
 *  - useNodeIdentitySuggestions() — introspects the real graph (discoverSchema)
 *    to suggest the actual node property keys.
 */
import { useEffect, useRef, useState } from 'react'
import { Fingerprint, KeyRound, ShieldAlert, ChevronDown, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerService } from '@/services/providerService'

// ── helpers (the single normalization contract) ─────────────────────────────

/** Trim and treat empty as the platform default "urn". */
export const normalizeIdentity = (v: string | null | undefined): string =>
    (v ?? '').trim() || 'urn'

/** True when the source maps identity to something other than the default. */
export const isIdentityOverridden = (v: string | null | undefined): boolean =>
    normalizeIdentity(v) !== 'urn'

/** The read-time Cypher resolution this value produces. */
export const identityCoalesceExpr = (v: string | null | undefined): string => {
    const n = normalizeIdentity(v)
    return n === 'urn' ? 'n.urn' : `coalesce(n.urn, n.${n})`
}

// ── display-name property (symmetric to identity; lower-stakes) ──────────────

/** Trim and treat empty as the platform default "name". */
export const normalizeName = (v: string | null | undefined): string =>
    (v ?? '').trim() || 'name'

/** True when the source maps the display name to something other than the default. */
export const isNameOverridden = (v: string | null | undefined): boolean =>
    normalizeName(v) !== 'name'

/** The read-time Cypher resolution the display-name mapping produces. */
export const nameCoalesceExpr = (v: string | null | undefined): string => {
    const n = normalizeName(v)
    return n === 'name' ? 'n.name' : `coalesce(n.displayName, n.${n})`
}

const PRESETS = ['urn', 'id', 'name']
const NAME_PRESETS = ['name', 'title', 'label']
// Property names most likely to BE the identity — surfaced first in suggestions.
const IDENTITY_PRIORITY = ['id', 'urn', 'name', 'key', 'uuid', 'guid', 'qualifiedname']

// ── graph-aware suggestions ─────────────────────────────────────────────────

/**
 * Lazily introspect the graph (only while `enabled`) and return its real node
 * property keys as identity-candidate suggestions. Degrades to [] (presets
 * only) on any failure — never blocks the control.
 */
export function useNodeIdentitySuggestions(
    providerId: string | undefined,
    graphName: string | undefined,
    enabled: boolean,
): { suggestions: string[]; loading: boolean } {
    const [suggestions, setSuggestions] = useState<string[]>([])
    const [loading, setLoading] = useState(false)
    const fetchedKey = useRef<string | null>(null)

    useEffect(() => {
        if (!enabled || !providerId) return
        const key = `${providerId}::${graphName ?? ''}`
        if (fetchedKey.current === key) return  // once per (provider, graph)
        fetchedKey.current = key
        let cancelled = false
        setLoading(true)
        providerService.discoverSchema(providerId, graphName)
            .then(res => {
                if (cancelled) return
                const keys = new Set<string>()
                Object.values(res.labelDetails || {}).forEach(d =>
                    (d.propertyKeys || []).forEach(k => k && keys.add(k)))
                const ranked = [...keys].sort((a, b) => {
                    const pa = IDENTITY_PRIORITY.indexOf(a.toLowerCase())
                    const pb = IDENTITY_PRIORITY.indexOf(b.toLowerCase())
                    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb)
                    return a.localeCompare(b)
                })
                setSuggestions(ranked)
            })
            .catch(() => { if (!cancelled) setSuggestions([]) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [enabled, providerId, graphName])

    return { suggestions, loading }
}

// ── read-only badge (discoverability on cards / headers) ────────────────────

export function NodeIdentityBadge({
    value,
    className,
}: {
    value?: string | null
    className?: string
}) {
    if (!isIdentityOverridden(value)) return null
    const v = normalizeIdentity(value)
    return (
        <span
            title={`Node identity mapped to "${v}" — resolved as ${identityCoalesceExpr(v)}`}
            className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold tracking-wide',
                'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
                className,
            )}
        >
            <Fingerprint className="w-3 h-3" />
            <span className="font-mono">{v}</span>
        </span>
    )
}

// ── editable expert disclosure ──────────────────────────────────────────────

interface NodeIdentityFieldProps {
    value: string
    onChange: (v: string) => void
    canEdit?: boolean
    /** 'panel' = detail-panel spacing; 'compact' = tighter for inline forms. */
    variant?: 'panel' | 'compact'
    /** When set, the field introspects the graph on open to suggest real props. */
    providerId?: string
    graphName?: string
    /** Force the disclosure open initially (defaults to open only when mapped). */
    defaultOpen?: boolean
    /** Optional symmetric display-name mapping. When onNameChange is provided,
     *  a second section for the node display-name property is rendered. */
    nameValue?: string
    onNameChange?: (v: string) => void
}

export function NodeIdentityField({
    value,
    onChange,
    canEdit = true,
    variant = 'panel',
    providerId,
    graphName,
    defaultOpen,
    nameValue,
    onNameChange,
}: NodeIdentityFieldProps) {
    const nameEnabled = typeof onNameChange === 'function'
    const nameOverridden = isNameOverridden(nameValue)
    const [open, setOpen] = useState(
        defaultOpen ?? (isIdentityOverridden(value) || nameOverridden),
    )
    const { suggestions, loading } = useNodeIdentitySuggestions(providerId, graphName, open)

    const normalized = normalizeIdentity(value)
    const overridden = isIdentityOverridden(value)
    const normalizedName = normalizeName(nameValue)
    // Real graph properties that aren't already offered as a static preset.
    const detected = suggestions.filter(s => !PRESETS.includes(s.toLowerCase()))

    const chip = (label: string, active: boolean, onClick: () => void, mono = true) => (
        <button
            key={label}
            type="button"
            disabled={!canEdit}
            onClick={onClick}
            className={cn(
                'px-2.5 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                mono && 'font-mono',
                active
                    ? 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-300'
                    : 'border-glass-border text-ink-muted hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
            )}
        >
            {label}
        </button>
    )

    return (
        <div className={cn('rounded-xl border border-glass-border overflow-hidden', variant === 'panel' ? 'mt-2' : 'mt-1')}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
            >
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/15 to-indigo-500/15 text-violet-500 flex-shrink-0">
                    <Fingerprint className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-ink">{nameEnabled ? 'Node Identity & Display Name' : 'Node Identity Property'}</span>
                        <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-violet-500/10 text-violet-500 tracking-wider">ADVANCED</span>
                        {(overridden || nameOverridden) && (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-500 tracking-wider">MAPPED</span>
                        )}
                    </div>
                    <p className="text-[11px] text-ink-muted mt-0.5 truncate">
                        {overridden
                            ? <>Identity falls back to <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">{normalized}</code> when a node has no <code className="font-mono text-[10px]">urn</code></>
                            : <>Using the platform default — nodes identified by <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">urn</code></>}
                    </p>
                </div>
                <ChevronDown className={cn('w-4 h-4 text-ink-muted transition-transform flex-shrink-0', open && 'rotate-180')} />
            </button>

            {open && (
                <div className="px-3 pb-3 pt-2 space-y-3 border-t border-glass-border animate-in slide-in-from-top-1 fade-in duration-200">
                    {/* What it is + why it matters */}
                    <div className="text-[11px] text-ink-secondary leading-relaxed space-y-1.5">
                        <p>
                            The platform identifies every node by a universal <strong className="text-ink">URN</strong> — it is how
                            aggregation, lineage, trace and the catalog cross-reference nodes across the graph. Nodes
                            <strong className="text-ink"> should</strong> carry a <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">urn</code> property.
                        </p>
                        <p>
                            Onboarded third-party graphs often key their nodes by a differently-named property
                            (e.g. <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">id</code>) and carry no <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">urn</code>.
                            Map that property here and the platform resolves identity at read time —
                            <strong className="text-ink"> without</strong> rewriting your graph, so the source can keep updating independently.
                        </p>
                    </div>

                    {/* Presets + free-form input */}
                    <div>
                        <label className="block text-[11px] font-medium text-ink-secondary mb-1.5">URN-equivalent property</label>
                        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                            {PRESETS.map(preset =>
                                chip(preset === 'urn' ? 'urn (default)' : preset, normalized === preset, () => onChange(preset)))}
                        </div>

                        {/* Graph-aware suggestions — the actual node properties we detected. */}
                        {(detected.length > 0 || loading) && (
                            <div className="mb-2">
                                <div className="flex items-center gap-1.5 text-[10px] font-semibold text-ink-muted mb-1.5">
                                    <Sparkles className="w-3 h-3 text-violet-500" />
                                    {loading ? 'Detecting node properties…' : 'Detected on your nodes'}
                                </div>
                                {detected.length > 0 && (
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        {detected.slice(0, 12).map(s => chip(s, normalized === s, () => onChange(s)))}
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="relative">
                            <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                            <input
                                type="text"
                                value={value}
                                disabled={!canEdit}
                                onChange={e => onChange(e.target.value)}
                                placeholder="urn"
                                spellCheck={false}
                                autoCapitalize="none"
                                autoCorrect="off"
                                className="w-full pl-8 pr-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-sm font-mono text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 disabled:opacity-50"
                            />
                        </div>
                    </div>

                    {/* Live resolution preview */}
                    <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border px-3 py-2">
                        <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted mb-1">Resolved at read time as</div>
                        <code className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono break-all">
                            {identityCoalesceExpr(value)}
                        </code>
                    </div>

                    {/* Display-name property — symmetric, lower-stakes mapping */}
                    {nameEnabled && (
                        <div className="pt-3 border-t border-glass-border space-y-2">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <label className="block text-[11px] font-medium text-ink-secondary">Display-name property</label>
                                    {nameOverridden && (
                                        <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-500 tracking-wider">MAPPED</span>
                                    )}
                                </div>
                                <p className="text-[11px] text-ink-muted mb-2 leading-relaxed">
                                    The label the platform shows for a node comes from <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">displayName</code>.
                                    If your graph stores its human-readable name under a different property, map it here so nodes don't render blank.
                                </p>
                                <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                                    {NAME_PRESETS.map(preset =>
                                        chip(preset === 'name' ? 'name (default)' : preset, normalizedName === preset, () => onNameChange!(preset)))}
                                </div>

                                {detected.length > 0 && (
                                    <div className="flex items-center gap-1.5 flex-wrap mb-2">
                                        {detected.slice(0, 12).map(s => chip(s, normalizedName === s, () => onNameChange!(s), true))}
                                    </div>
                                )}

                                <div className="relative">
                                    <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                                    <input
                                        type="text"
                                        value={nameValue ?? ''}
                                        disabled={!canEdit}
                                        onChange={e => onNameChange!(e.target.value)}
                                        placeholder="name"
                                        spellCheck={false}
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        className="w-full pl-8 pr-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-sm font-mono text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-violet-500/50 focus:border-violet-500/50 disabled:opacity-50"
                                    />
                                </div>
                            </div>
                            <div className="rounded-lg bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border px-3 py-2">
                                <div className="text-[9px] font-semibold uppercase tracking-wider text-ink-muted mb-1">Node label resolved as</div>
                                <code className="text-[11px] text-emerald-600 dark:text-emerald-400 font-mono break-all">
                                    {nameCoalesceExpr(nameValue)}
                                </code>
                            </div>
                        </div>
                    )}

                    {/* Risk callout — only when diverging from the default */}
                    {overridden && (
                        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/[0.07] border border-amber-500/20">
                            <ShieldAlert className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                            <div className="text-[11px] text-amber-600/90 dark:text-amber-400/90 leading-relaxed">
                                <strong>Expert setting — handle with care.</strong> The chosen property must be
                                <strong> unique per node</strong> and stable; it becomes this source's identity everywhere the
                                platform reads it. A non-unique or wrong mapping can merge distinct nodes or drop them from
                                aggregation. The change takes effect on the <strong>next</strong> aggregation run.
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
