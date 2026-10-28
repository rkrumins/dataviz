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
 *  - <NodeIdentityFacts/>  — an entity's identifier and name properties, with where
 *    each setting comes from (the entity drawer).
 *  - useNodeIdentitySuggestions() — introspects the real graph (discoverSchema)
 *    to suggest the actual node property keys.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Fingerprint, KeyRound, ShieldAlert, ChevronDown, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { canvasScopeWorkspaceId } from '@/lib/canvasScope'
import { RESERVED_PROPERTY_KEYS, readSchemaField } from '@/lib/nodeFields'
import { providerService } from '@/services/providerService'
import type { DataSourceResponse } from '@/services/workspaceService'
import { useActiveView } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'

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

// ── the entity editors' Name input ───────────────────────────────────────────

/** The schema fields the entity editors never offer as inputs of their own: `name` — the Name
 *  input is that field — and the source's own name and identity properties. The server keeps those
 *  two in step with the Name and the urn on every save (`node_identity.bind_node_write`), so an
 *  input of their own would be overwritten when a new entity is created. A mapping onto a field the
 *  platform owns is not bound, so it stays offered. */
export function boundFieldIds(
    mapping?: Pick<DataSourceResponse, 'nameProperty' | 'identityProperty'> | null,
): Set<string> {
    const ids = new Set(['name'])
    const name = normalizeName(mapping?.nameProperty)
    if (!RESERVED_PROPERTY_KEYS.has(name)) ids.add(name)
    const identity = normalizeIdentity(mapping?.identityProperty)
    if (isIdentityOverridden(identity) && !RESERVED_PROPERTY_KEYS.has(identity)) ids.add(identity)
    return ids
}

/** The resolved mapping of the data source the canvas shows: the active view's — else its
 *  workspace's primary, which is what a route reads when a view names none — looked up in the
 *  workspace list, where the server resolved it across all four scopes. Null until that list has
 *  loaded. */
export function useCanvasNodeIdentity(): DataSourceResponse | null {
    const view = useActiveView()
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const wsId = canvasScopeWorkspaceId(view?.workspaceId, activeWorkspaceId)
    const dsId = view?.dataSourceId ?? null
    return useWorkspacesStore((s) => {
        const sources = s.workspaces.find((w) => w.id === wsId)?.dataSources
        return (dsId ? sources?.find((d) => d.id === dsId) : sources?.find((d) => d.isPrimary)) ?? null
    })
}

/** An entity as the save rule reads it: its display name and its own properties. */
export interface NamedShape {
    displayName?: unknown
    properties?: Record<string, unknown>
}

const blank = (v: unknown): boolean => v == null || (typeof v === 'string' && !v.trim())

/** What a save stores for an entity's name property and display name: the server's rule
 *  (`node_identity.bind_node_write`), here so the editor can say what saving does before it does
 *  it. `backend/tests/fixtures/node_identity/name_binding.json` runs against both, so the two
 *  cannot drift. `prior` is the entity as read (null for one not saved yet), `value` as it will be
 *  sent, and `minted` says the server mints its urn — an editor create. Null when the mapping is
 *  unknown or names a field the platform owns, which the server leaves alone. */
export function boundName(
    prior: NamedShape | null,
    value: NamedShape,
    mapping: Pick<DataSourceResponse, 'nameProperty'> | null | undefined,
    minted = false,
): { property: string; name: unknown; displayName: unknown } | null {
    if (!mapping) return null
    const property = normalizeName(mapping.nameProperty)
    if (RESERVED_PROPERTY_KEYS.has(property)) return null
    const name = value.properties?.[property]
    const display = value.displayName
    let outName = name
    let outDisplay = display
    if (!prior) {
        if (!blank(display) && (minted || blank(name))) outName = display
        else if (blank(display) && !blank(name) && typeof name === 'string') outDisplay = name
    } else {
        const was = prior.properties?.[property]
        const wasDisplay = prior.displayName
        if (blank(name)) {
            if (blank(was) && !blank(display)) outName = display
        } else if (blank(was) || blank(wasDisplay) || String(was) === String(wasDisplay)) {
            const displayChanged = display !== wasDisplay
            const nameChanged = name !== was
            if (displayChanged && !nameChanged && !blank(display)) outName = display
            else if (nameChanged && !displayChanged && typeof name === 'string') outDisplay = name
        }
    }
    return { property, name: outName, displayName: outDisplay }
}

/** What saving does to the name property, for the Name input to say before it happens:
 *  - `follows` — the property changes with the Name (or, when empty, is filled from it);
 *  - `renames` — the Name changes with the property;
 *  - `same` — the two agree, and still will;
 *  - `apart` — they differ and stay so (`renamed`: this edit changed the Name; `edited`: it
 *    changed the property). */
export type NameOnSave =
    | { kind: 'follows'; property: string; from: unknown; to: unknown }
    | { kind: 'renames'; property: string; to: unknown }
    | { kind: 'same'; property: string }
    | { kind: 'apart'; property: string; value: unknown; renamed: boolean; edited: boolean }

export function nameOnSave(
    prior: NamedShape | null,
    value: NamedShape,
    mapping: Pick<DataSourceResponse, 'nameProperty'> | null | undefined,
    minted = false,
): NameOnSave | null {
    const saved = boundName(prior, value, mapping, minted)
    if (!saved) return null
    const { property } = saved
    const now = value.properties?.[property]
    if (saved.displayName !== value.displayName) return { kind: 'renames', property, to: saved.displayName }
    if (saved.name !== now) return { kind: 'follows', property, from: now, to: saved.name }
    if (blank(now) || String(now) === String(value.displayName)) return { kind: 'same', property }
    return {
        kind: 'apart', property, value: now,
        renamed: !!prior && value.displayName !== prior.displayName,
        edited: !!prior && now !== prior.properties?.[property],
    }
}

/** Where a resolved mapping came from — mirrors the backend's provenance
 *  strings (`backend/app/services/node_identity.py`). */
export type IdentitySource = 'data_source' | 'provider' | 'workspace' | 'global' | 'default'

/** Human label for each inherited scope. `data_source` and `default` are absent
 *  because neither reads as "inherited from" anything. */
const SOURCE_LABELS: Partial<Record<IdentitySource, string>> = {
    provider: 'the provider',
    workspace: 'the workspace',
    global: 'the platform default',
}

/** True when the value in force was set somewhere ABOVE this data source. */
export const isInherited = (source?: IdentitySource): boolean =>
    !!source && source in SOURCE_LABELS

const SOURCE_PHRASES: Record<IdentitySource, string> = {
    data_source: 'set on this data source',
    provider: 'from the provider',
    workspace: 'from the workspace',
    global: 'platform default',
    default: 'built-in default',
}

/** Where a resolved setting comes from, as an entity's details say it. Empty when unknown. */
export const identitySourcePhrase = (source?: IdentitySource | null): string =>
    (source && SOURCE_PHRASES[source]) || ''

/** The provenance line beside a field: either "inherited from X", or — when
 *  this level is the one overriding — the way back to inheriting.
 *
 *  Clearing sends an empty string, which the API stores as NULL rather than as
 *  the literal default, so the value falls through to whatever is underneath.
 *  Without this control the only way to stop overriding would be to type the
 *  inherited value by hand, which pins it and silently stops tracking. */
function inheritNote(
    source: IdentitySource | undefined,
    canEdit: boolean,
    onReset: () => void,
) {
    if (isInherited(source)) {
        return (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider bg-sky-500/10 text-sky-500">
                INHERITED FROM {SOURCE_LABELS[source!]!.replace(/^the /, '').toUpperCase()}
            </span>
        )
    }
    if (source !== 'data_source' || !canEdit) return null
    return (
        <button
            type="button"
            onClick={onReset}
            className="text-[10px] text-ink-muted hover:text-violet-500 underline underline-offset-2 transition-colors"
        >
            Reset to inherited
        </button>
    )
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

// ── an entity's identity facts (the entity drawer) ──────────────────────────

function Fact({ label, property, source, children }: {
    label: string
    property: string
    source?: IdentitySource
    children?: ReactNode
}) {
    const from = identitySourcePhrase(source)
    return (
        <div className="flex items-start justify-between gap-4 py-1.5">
            <dt className="text-xs text-ink-muted min-w-[110px]">{label}</dt>
            <dd className="text-xs text-right min-w-0">
                <code className="font-mono text-ink">{property}</code>
                {from && <span className="text-ink-muted"> · {from}</span>}
                {children != null && <span className="block text-ink-muted break-words">{children}</span>}
            </dd>
        </div>
    )
}

/** Which property identifies an entity and which holds its name, as its data source is configured
 *  (across data source, provider, workspace and platform), where each setting comes from, and this
 *  entity's values. `pending`: not saved yet, so the server has not filled them in. Nothing until
 *  the workspace list has loaded. */
export function NodeIdentityFacts({ data, pending = false }: {
    data: Record<string, unknown>
    pending?: boolean
}) {
    const mapping = useCanvasNodeIdentity()
    if (!mapping) return null
    const identity = normalizeIdentity(mapping.identityProperty)
    const name = normalizeName(mapping.nameProperty)
    const idValue = readSchemaField(data, identity)
    const nameValue = readSchemaField(data, name)
    const display = data.label ?? data.displayName
    return (
        <dl className="mt-2" aria-label="How this data source identifies and names entities">
            <Fact label="Identifier property" property={identity} source={mapping.identityPropertySource}>
                {identity === 'urn' ? null
                    : !blank(idValue) ? String(idValue)
                        : pending ? 'Set to its URN when saved' : 'Not set'}
            </Fact>
            <Fact label="Name property" property={name} source={mapping.namePropertySource}>
                {!blank(nameValue)
                    ? <>{String(nameValue)}{String(nameValue) !== String(display ?? '') && ' · differs from the name'}</>
                    : pending ? 'Set from the name when saved' : 'Not set'}
            </Fact>
        </dl>
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
    /** Which scope this control edits. Changes the copy: a provider- or
     *  workspace-level control sets a DEFAULT for the sources under it, which is
     *  a materially different statement from mapping one graph. */
    scope?: 'dataSource' | 'workspace' | 'provider' | 'platform'
    /** Provenance of the values in `value` / `nameValue`, from the API. Only
     *  meaningful at data-source scope, where a value may have been inherited. */
    identitySource?: IdentitySource
    nameSource?: IdentitySource
}

/** Scope-specific framing for the disclosure header. */
const SCOPE_COPY = {
    dataSource: {
        title: 'Node Identity & Display Name',
        blurb: 'this source',
    },
    workspace: {
        title: 'Default Node Identity & Display Name',
        blurb: 'every source in this workspace that does not set its own',
    },
    provider: {
        title: 'Default Node Identity & Display Name',
        blurb: 'every source on this provider that does not set its own',
    },
    platform: {
        title: 'Platform Node Identity & Display Name',
        blurb: 'every source that does not set its own, or inherit one from its provider or workspace',
    },
} as const

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
    scope = 'dataSource',
    identitySource,
    nameSource,
}: NodeIdentityFieldProps) {
    const nameEnabled = typeof onNameChange === 'function'
    const nameOverridden = isNameOverridden(nameValue)
    const identityInherited = isInherited(identitySource)
    const nameInherited = isInherited(nameSource)
    const copy = SCOPE_COPY[scope]
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
                        <span className="text-sm font-medium text-ink">{nameEnabled ? copy.title : 'Node Identity Property'}</span>
                        <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-violet-500/10 text-violet-500 tracking-wider">ADVANCED</span>
                        {(identityInherited || nameInherited) ? (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-sky-500/10 text-sky-500 tracking-wider">INHERITED</span>
                        ) : (overridden || nameOverridden) && (
                            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-500 tracking-wider">MAPPED</span>
                        )}
                    </div>
                    <p className="text-[11px] text-ink-muted mt-0.5 truncate">
                        {identityInherited
                            ? <>Inherited from {SOURCE_LABELS[identitySource!]} — nodes identified by <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">{normalized}</code></>
                            : overridden
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
                            Map that property here and it applies to {copy.blurb}.
                        </p>
                        <p>
                            Reads resolve the mapping <strong className="text-ink">immediately</strong>. Aggregation
                            additionally copies the mapped values onto <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">urn</code> and <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">displayName</code> on
                            its next run — writes and rollup edges key on those properties directly and cannot be
                            resolved on the fly. Only values it filled in are ever rewritten; a node that already
                            carries its own <code className="px-1 rounded bg-black/10 dark:bg-white/10 font-mono text-[10px]">urn</code> is never touched.
                            A read-only source or a dedicated projection is never written to at all — it will read
                            correctly, but won't gain rollup edges.
                        </p>
                    </div>

                    {/* Presets + free-form input */}
                    <div>
                        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            <label className="block text-[11px] font-medium text-ink-secondary">URN-equivalent property</label>
                            {inheritNote(identitySource, canEdit, () => onChange(''))}
                        </div>
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
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                    <label className="block text-[11px] font-medium text-ink-secondary">Display-name property</label>
                                    {!nameInherited && nameOverridden && (
                                        <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-500 tracking-wider">MAPPED</span>
                                    )}
                                    {inheritNote(nameSource, canEdit, () => onNameChange!(''))}
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
