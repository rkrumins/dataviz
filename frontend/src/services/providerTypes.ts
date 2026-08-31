/**
 * providerTypes — the one module that knows what a provider type is.
 *
 * Before this, the set of provider types was hand-declared in ~15 places
 * (`providerService.ts`'s `ProviderType` union, the onboarding wizard's own
 * `PROVIDER_TYPES` card list, per-page label/tint maps, ...). Adding a type
 * meant finding all of them. This module is the single place that:
 *
 *   - declares the id union (`PROVIDER_TYPE_IDS` / `ProviderType`) — the
 *     union is DERIVED, never hand-maintained;
 *   - declares the brand visuals for each id (`PROVIDER_VISUALS`) as a
 *     `Record<ProviderType, …>`, which is deliberately load-bearing: adding
 *     an id to `PROVIDER_TYPE_IDS` without adding its visual is a *compile
 *     error*, not a silently-half-registered type;
 *   - mirrors the wire shape of `GET /admin/providers/types` and offers a
 *     hand-written runtime guard for it (there is no OpenAPI client, no
 *     zod — `providerService`'s `request<T>` merely casts `res.json()`);
 *   - carries an offline snapshot (`STATIC_PROVIDER_TYPES`) pinned to the
 *     backend's own fixture, so "what the frontend assumes offline" and
 *     "what the server actually sends" can never quietly drift apart —
 *     see `__tests__/providerTypes.catalog.test.ts`.
 *
 * Every other call site collapses onto this module in later tasks; this one
 * only builds it (plus `providerService`'s new `listTypes` /
 * `discoverSchemaUnsaved`). It deliberately does no fetching itself, so
 * there is no import cycle with `providerService.ts`.
 */
import type { ComponentType } from 'react'
import { Database } from 'lucide-react'
import { DataHubLogo, FalkorDBLogo, Neo4jLogo, SpannerLogo, getProviderLogo } from '@/components/admin/ProviderLogos'
import providerTypesFixture from './__fixtures__/providerTypes.backend.json'

/**
 * Re-exported (not moved) — see the doc comment on `getProviderLogo` in
 * `ProviderLogos.tsx` for why: that module already has to be evaluated
 * before this one (its logo components feed `PROVIDER_VISUALS` below), so
 * a re-export running the other way would make the two modules mutually
 * dependent. A verified-live circular-import bug, not a style nit — see the
 * comment there for the reproduction.
 */
export { getProviderLogo }

// ── id union ─────────────────────────────────────────────────────────────

/** Every provider type id the frontend knows about. The single source of
 *  truth `ProviderType` is derived from — adding a new id here without a
 *  matching `PROVIDER_VISUALS` entry fails to compile (see below). */
export const PROVIDER_TYPE_IDS = ['falkordb', 'neo4j', 'datahub', 'spanner', 'mock'] as const

export type ProviderType = (typeof PROVIDER_TYPE_IDS)[number]

/** Runtime guard for wire data — a response may carry an id this bundle
 *  predates (e.g. a newer backend already knows `'arcadedb'`). */
export function isProviderType(x: unknown): x is ProviderType {
    return typeof x === 'string' && (PROVIDER_TYPE_IDS as readonly string[]).includes(x)
}

// ── brand visuals ────────────────────────────────────────────────────────

export interface ProviderTypeVisual {
    /** Full brand label, e.g. shown on the wizard's type-picker cards. */
    label: string
    /** Compact label for tight spaces (workspace badges). */
    shortLabel: string
    /** Card blurb (wizard / RegistryConnections / ScopeStep). */
    desc: string
    Logo: ComponentType<{ className?: string }>
    /** Card tint: text + bg + border tailwind classes. */
    color: string
    /** Hero gradient (DataSourceProfile). */
    tint: string
    /** Accent bar (DataSourceGridCard). */
    accent: string
}

/**
 * The forcing function: every `PROVIDER_TYPE_IDS` member MUST have an entry
 * here, enforced by the compiler via `Record<ProviderType, …>`. Do not
 * loosen this to `Partial<>` or an index signature — that would silently
 * allow a half-registered provider type, which is the exact failure mode
 * this record exists to make impossible.
 */
export const PROVIDER_VISUALS: Record<ProviderType, ProviderTypeVisual> = {
    falkordb: {
        label: 'FalkorDB',
        shortLabel: 'FDB',
        desc: 'High-performance graph database',
        Logo: FalkorDBLogo,
        color: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
        tint: 'from-amber-500/15 to-orange-500/5 text-amber-500',
        accent: 'bg-gradient-to-r from-purple-500 via-pink-500 to-orange-400',
    },
    neo4j: {
        label: 'Neo4j',
        shortLabel: 'Neo4j',
        desc: 'The original graph database',
        Logo: Neo4jLogo,
        color: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
        tint: 'from-blue-500/15 to-indigo-500/5 text-blue-500',
        accent: 'bg-gradient-to-r from-blue-500 to-blue-400',
    },
    datahub: {
        label: 'DataHub',
        shortLabel: 'DH',
        desc: 'LinkedIn metadata platform',
        Logo: DataHubLogo,
        color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20',
        tint: 'from-emerald-500/15 to-teal-500/5 text-emerald-500',
        accent: 'bg-gradient-to-r from-blue-600 via-orange-400 to-red-500',
    },
    spanner: {
        label: 'Google Spanner Graph',
        shortLabel: 'Spanner',
        desc: 'Cloud-native distributed property graph (GQL). Requires Enterprise edition.',
        Logo: SpannerLogo,
        color: 'text-sky-500 bg-sky-500/10 border-sky-500/20',
        tint: 'from-sky-500/15 to-cyan-500/5 text-sky-500',
        // No dedicated accent existed pre-catalog (DataSourceGridCard's ternary
        // fell through to this same indigo/violet gradient for Spanner, sharing
        // it with the "unrecognized type" case) — kept identical so a future
        // cutover to this module changes zero pixels for existing Spanner cards.
        accent: 'bg-gradient-to-r from-indigo-500 to-violet-500',
    },
    mock: {
        label: 'Mock',
        shortLabel: 'Mock',
        desc: 'In-memory fake provider used in tests and local development.',
        Logo: Database,
        color: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
        tint: 'from-slate-500/15 to-slate-400/5 text-slate-500',
        accent: 'bg-gradient-to-r from-slate-500 to-slate-400',
    },
}

/** Fallback visual for an id outside `PROVIDER_TYPE_IDS` (a newer backend,
 *  a typo, a not-yet-onboarded PR3 type). Neutral icon, neutral tints. */
export const UNKNOWN_PROVIDER_VISUAL: ProviderTypeVisual = {
    label: 'Unknown',
    shortLabel: '?',
    desc: '',
    Logo: Database,
    color: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
    tint: 'from-slate-500/15 to-slate-400/5 text-slate-500',
    accent: 'bg-gradient-to-r from-slate-400 to-slate-300',
}

/** The visual for `type`, or `UNKNOWN_PROVIDER_VISUAL` with `label` set to
 *  the raw id when it isn't one of ours — never crashes on foreign data. */
export function providerVisual(type: string | null | undefined): ProviderTypeVisual {
    if (!type) return UNKNOWN_PROVIDER_VISUAL
    return PROVIDER_VISUALS[type as ProviderType] ?? { ...UNKNOWN_PROVIDER_VISUAL, label: type }
}

export function providerLabel(type: string | null | undefined): string {
    return providerVisual(type).label
}

export function providerShortLabel(type: string | null | undefined): string {
    return providerVisual(type).shortLabel
}

// ── wire shape of GET /admin/providers/types ────────────────────────────
// Mirrors backend/common/models/management.py's ProviderType* models
// (camelCase on the wire via Pydantic aliases).

/** Mirrors `backend.common.interfaces.provider.ProviderFeature`. The first
 *  three double as `ProviderTypeCapabilities`' own boolean fields — see
 *  `supportsFeature` below. */
export type ProviderFeature =
    | 'writable'
    | 'full_crud'
    | 'graph_copy'
    | 'trace_closure'
    | 'coarse_trace'
    | 'deep_search'
    | 'aggregation_materialization'
    | 'blank_models'
    | 'schema_discovery'
    | 'multi_graph'

export type ShapeKind = 'generic' | 'falkordb' | 'spanner'
export type AuthKind = 'basic' | 'token' | 'service_account' | 'none'
/** Label only — no UI behaviour hangs off this. */
export type ProviderFamily = 'cypher' | 'gql' | 'graphql' | 'native'

export interface ProviderTypeField {
    key: string
    label: string
    kind: string
    location: string
    required?: boolean
    secret?: boolean
    default?: unknown
    placeholder?: string
    help?: string
}

export interface ProviderTypeConnectionShape {
    kind: ShapeKind
    usesHostPort: boolean
    defaultPort: number | null
    tls: 'flag' | 'none'
    auth: AuthKind
    databaseField: ProviderTypeField | null
    fields: ProviderTypeField[]
    secretCredentialKeys: string[]
    extraConfigKeys: string[]
}

export interface ProviderTypeInfo {
    id: string
    label: string
    description: string
    docsUrl?: string | null
    family: ProviderFamily
    capabilities: {
        writable: boolean
        fullCrud: boolean
        isExternal: boolean
        supportsCopy: boolean
        features: string[]
    }
    connectionShape: ProviderTypeConnectionShape
    adminVisible: boolean
}

/** A catalog row plus the frontend-only visual it renders with. */
export interface ProviderTypeEntry extends ProviderTypeInfo {
    visual: ProviderTypeVisual
}

// ── runtime guard ────────────────────────────────────────────────────────
// There is no OpenAPI client and no zod; `providerService`'s `request<T>`
// merely casts `res.json()`. These are the hand-written guards for the one
// endpoint that matters enough to validate: a malformed row is dropped
// (logged) rather than crashing the caller or rendering garbage.

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null
}

function parseProviderTypeField(raw: unknown): ProviderTypeField | null {
    if (!isRecord(raw)) return null
    const { key, label, kind, location } = raw
    if (typeof key !== 'string' || typeof label !== 'string' || typeof kind !== 'string' || typeof location !== 'string') {
        return null
    }
    return {
        key,
        label,
        kind,
        location,
        required: typeof raw.required === 'boolean' ? raw.required : undefined,
        secret: typeof raw.secret === 'boolean' ? raw.secret : undefined,
        default: 'default' in raw ? raw.default : undefined,
        placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : undefined,
        help: typeof raw.help === 'string' ? raw.help : undefined,
    }
}

/** Parses one `ProviderTypeInfo` from an unknown value, or `null` if its
 *  shape doesn't hold up. Tolerates unknown `family` / feature strings
 *  (informational only) — it only rejects a row missing the fields other
 *  helpers in this module actually read. */
export function parseProviderTypeInfo(raw: unknown): ProviderTypeInfo | null {
    if (!isRecord(raw)) return null
    const { id, label, description, family, capabilities, connectionShape } = raw
    if (typeof id !== 'string' || typeof label !== 'string' || typeof description !== 'string' || typeof family !== 'string') {
        return null
    }
    if (!isRecord(capabilities)) return null
    if (!isRecord(connectionShape)) return null

    const { writable, fullCrud, isExternal, supportsCopy, features } = capabilities
    if (
        typeof writable !== 'boolean' ||
        typeof fullCrud !== 'boolean' ||
        typeof isExternal !== 'boolean' ||
        typeof supportsCopy !== 'boolean' ||
        !Array.isArray(features)
    ) {
        return null
    }

    const { kind, usesHostPort, tls, auth, secretCredentialKeys, extraConfigKeys } = connectionShape
    if (
        typeof kind !== 'string' ||
        typeof usesHostPort !== 'boolean' ||
        typeof tls !== 'string' ||
        typeof auth !== 'string' ||
        !Array.isArray(secretCredentialKeys) ||
        !Array.isArray(extraConfigKeys)
    ) {
        return null
    }

    const fieldsRaw = connectionShape.fields
    const fields = Array.isArray(fieldsRaw)
        ? fieldsRaw.map(parseProviderTypeField).filter((f): f is ProviderTypeField => f !== null)
        : []

    return {
        id,
        label,
        description,
        docsUrl: typeof raw.docsUrl === 'string' ? raw.docsUrl : null,
        family: family as ProviderFamily,
        capabilities: {
            writable,
            fullCrud,
            isExternal,
            supportsCopy,
            features: features.filter((f): f is string => typeof f === 'string'),
        },
        connectionShape: {
            kind: kind as ShapeKind,
            usesHostPort,
            defaultPort: typeof connectionShape.defaultPort === 'number' ? connectionShape.defaultPort : null,
            tls: tls as 'flag' | 'none',
            auth: auth as AuthKind,
            databaseField: parseProviderTypeField(connectionShape.databaseField),
            fields,
            secretCredentialKeys: secretCredentialKeys.filter((k): k is string => typeof k === 'string'),
            extraConfigKeys: extraConfigKeys.filter((k): k is string => typeof k === 'string'),
        },
        adminVisible: typeof raw.adminVisible === 'boolean' ? raw.adminVisible : true,
    }
}

/** Parses `GET /admin/providers/types`' body. Never throws: a non-array
 *  input returns `[]`, and each malformed row is dropped (with a console
 *  warning) rather than poisoning the rest of the list. */
export function parseProviderTypeList(raw: unknown): ProviderTypeInfo[] {
    if (!Array.isArray(raw)) return []
    const out: ProviderTypeInfo[] = []
    for (const row of raw) {
        const parsed = parseProviderTypeInfo(row)
        if (parsed) {
            out.push(parsed)
        } else {
            console.warn('providerTypes: dropping malformed provider-type row', row)
        }
    }
    return out
}

// ── offline snapshot ─────────────────────────────────────────────────────

/**
 * Offline snapshot of the backend catalog for the 4 admin-visible types,
 * plus `mock` (never registered in the backend catalog — see
 * `backend.common.providers.catalog.LEGACY_DB_ONLY_TYPES` — so it is
 * synthesized here, `adminVisible: false`, rather than sourced from the
 * fixture below).
 *
 * The 4 real rows are parsed from `__fixtures__/providerTypes.backend.json`,
 * generated by the backend's own test
 * (`tests/test_api_provider_types.py`, `UPDATE_PROVIDER_TYPES_FIXTURE=1`) —
 * NOT hand-written. Drift between what the frontend assumes offline and what
 * the server actually sends is a failing test rather than a support ticket,
 * but it takes both halves of the chain to say so, and only one of them lives
 * here: `__tests__/providerTypes.catalog.test.ts` pins these rows to the
 * fixture, and `test_list_provider_types_generates_the_frontend_fixture` pins
 * the fixture to the live endpoint response on every run. Nothing on this
 * side of the wire can see the server on its own.
 */
const BACKEND_PROVIDER_TYPES: ProviderTypeInfo[] = parseProviderTypeList(providerTypesFixture)

const MOCK_PROVIDER_TYPE_INFO: ProviderTypeInfo = {
    id: 'mock',
    label: 'Mock',
    description: 'In-memory fake provider used in tests and local development.',
    docsUrl: null,
    family: 'native',
    // Mirrors backend/common/interfaces/provider.py's `_DEFAULT_CAPABILITY` —
    // `capability_for("mock")` falls through to the same default as any
    // other unrecognized type.
    capabilities: { writable: false, fullCrud: false, isExternal: true, supportsCopy: false, features: [] },
    connectionShape: {
        kind: 'generic',
        usesHostPort: false,
        defaultPort: null,
        tls: 'none',
        auth: 'none',
        databaseField: null,
        fields: [],
        secretCredentialKeys: [],
        extraConfigKeys: [],
    },
    adminVisible: false,
}

export const STATIC_PROVIDER_TYPES: ProviderTypeEntry[] = [...BACKEND_PROVIDER_TYPES, MOCK_PROVIDER_TYPE_INFO].map(
    info => ({ ...info, visual: providerVisual(info.id) }),
)

// ── catalog helpers ──────────────────────────────────────────────────────

/** Attaches each info row's visual, or falls back to the static snapshot
 *  when the live catalog query hasn't resolved yet.
 *
 *  An EMPTY array falls back too, not just `undefined`. `[]` is truthy, so
 *  `!infos` let an all-rows-dropped parse through as a legitimate answer of
 *  "this deployment has no provider types" — the exact scenario
 *  `parseProviderTypeList`'s defensive parsing exists for (a wire-shape
 *  change drops every row). Every list-iterating surface then renders
 *  nothing: `ProviderOnboardingWizard`'s type cards, `RegistryConnections`,
 *  `useBlankScopeOptions`. No deployment has zero provider types, so the
 *  offline snapshot is always the better answer than none. */
export function mergeCatalog(infos: ProviderTypeInfo[] | undefined): ProviderTypeEntry[] {
    if (!infos?.length) return STATIC_PROVIDER_TYPES
    return infos.map(info => ({ ...info, visual: providerVisual(info.id) }))
}

/** A generic, feature-less entry for an id found nowhere — the shape a
 *  caller can still safely read `.connectionShape.kind` /
 *  `.capabilities.features` off of without a null check. */
function syntheticUnknownEntry(id: string): ProviderTypeEntry {
    return {
        id,
        label: id,
        description: '',
        docsUrl: null,
        family: 'native',
        capabilities: { writable: false, fullCrud: false, isExternal: true, supportsCopy: false, features: [] },
        connectionShape: {
            kind: 'generic',
            usesHostPort: true,
            defaultPort: null,
            tls: 'none',
            auth: 'none',
            databaseField: null,
            fields: [],
            secretCredentialKeys: [],
            extraConfigKeys: [],
        },
        adminVisible: false,
        visual: providerVisual(id),
    }
}

/** Looks `id` up in `types` (the live/merged catalog, when the caller has
 *  one), then in the static snapshot, then synthesizes a generic unknown
 *  entry — a caller never has to null-check the result. */
export function providerTypeEntry(
    id: string | null | undefined,
    types: ProviderTypeEntry[] = STATIC_PROVIDER_TYPES,
): ProviderTypeEntry {
    if (id) {
        const found = types.find(t => t.id === id) ?? STATIC_PROVIDER_TYPES.find(t => t.id === id)
        if (found) return found
    }
    return syntheticUnknownEntry(id ?? '')
}

/**
 * Whether `feature` is available for a provider type (by id, looked up in
 * `types` — default the static snapshot — or by an entry already in hand).
 *
 * Mirrors `backend.common.interfaces.provider.ProviderCapability.supports()`
 * exactly: the three legacy booleans (`writable` / `full_crud` /
 * `graph_copy`) are the authoritative answer for their own `ProviderFeature`
 * members, so a caller migrating a `.writable` check never gets a different
 * answer; every other feature is a plain membership test on `features`.
 */
export function supportsFeature(
    idOrEntry: string | ProviderTypeEntry,
    feature: ProviderFeature,
    types?: ProviderTypeEntry[],
): boolean {
    const entry = typeof idOrEntry === 'string' ? providerTypeEntry(idOrEntry, types) : idOrEntry
    const caps = entry.capabilities
    switch (feature) {
        case 'writable':
            return caps.writable
        case 'full_crud':
            return caps.fullCrud
        case 'graph_copy':
            return caps.supportsCopy
        default:
            return caps.features.includes(feature)
    }
}

export function shapeKind(id: string | null | undefined, types?: ProviderTypeEntry[]): ShapeKind {
    return providerTypeEntry(id, types).connectionShape.kind
}

/** `0` rather than `null` for a shape with no default port (Spanner) — lets
 *  callers keep a plain `port: number` in form state. */
export function defaultPortFor(id: string | null | undefined, types?: ProviderTypeEntry[]): number {
    return providerTypeEntry(id, types).connectionShape.defaultPort ?? 0
}

/** Extra-config keys the connection form itself owns for this type, plus
 *  the schema-mapping key every type shares — the wizard's
 *  `preserveUnknownKeys` uses this to avoid clobbering keys it didn't
 *  write. */
export function formOwnedExtraKeys(entry: ProviderTypeEntry): Set<string> {
    return new Set(['schemaMapping', ...entry.connectionShape.extraConfigKeys])
}
