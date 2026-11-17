/**
 * The shapes the settings kit renders, mirroring the server exactly.
 *
 * Two documents:
 *
 * - THE REGISTRY (`SettingsSchema`): what every setting is and the words that explain it. Built by
 *   `schema()` in `backend/app/config/settings_types.py`, served by
 *   `GET /api/v1/settings/versioned-graphs/schema` and generated into
 *   `src/generated/versionedGraphSettings.json`. Keys are the dataclass fields in camelCase; a
 *   callable on the Python side arrives already rendered (an example, a posture sentence, a
 *   recommendation for this platform).
 * - THE RESOLVER'S ANSWER (`ResolvedSetting`), per key: the value in force at a scope, the value
 *   chosen, which level it came from, the whole trail Default → Platform → Workspace → Graph, a
 *   status and why, and whether the viewer may change it.
 *
 * `null` always means "nothing chosen here". `"unlimited"` and `"forever"` are values.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────
// Each word list is a value as well as a type, so a test can hold the catalogue to it.

export const SCOPES = ['platform', 'workspace', 'graph'] as const
export type Scope = (typeof SCOPES)[number]
/** A level of the trail: the three scopes, after the default. */
export type TrailScope = 'default' | Scope
export const EDITORS = ['system_admin', 'workspace_admin'] as const
export type Editor = (typeof EDITORS)[number]
export const DIMENSIONS = ['consistency', 'availability', 'read_speed', 'update_speed', 'memory', 'database_load', 'cost'] as const
export type Dimension = (typeof DIMENSIONS)[number]
export const KINDS = [
    'bool', 'count', 'ratio', 'percent', 'ms', 'seconds', 'bytes', 'choice', 'days',
    'days_or_forever', 'count_or_unlimited', 'bytes_or_unlimited', 'identifier', 'refusal_budget',
] as const
export type Kind = (typeof KINDS)[number]
export const TAKES_EFFECT = [
    'next_read', 'next_write', 'next_pass', 'next_publish', 'build_start', 'build_step', 'next_switch',
    'capacity_pass', 'hourly_sweep', 'reaper_pass', 'next_import', 'next_draft', 'next_review_action',
    'next_fork', 'new_graphs', 'next_load',
] as const
export type TakesEffectWhen = (typeof TAKES_EFFECT)[number]
export const AUDIENCES = ['business', 'operator'] as const
export type Audience = (typeof AUDIENCES)[number]
export const WEIGHTS = ['low', 'medium', 'high'] as const
export type Weight = (typeof WEIGHTS)[number]
export const RISKS = ['low', 'medium', 'high'] as const
export type Risk = (typeof RISKS)[number]
export const VERDICTS = ['better', 'same', 'worse'] as const
export type Verdict = (typeof VERDICTS)[number]
export const VISUALS = ['read_timeline', 'write_rhythm', 'memory_marks', 'copy_room', 'retention_timeline', 'idle_timeline', 'guard_meter'] as const
export type Visual = (typeof VISUALS)[number]
export const LIMIT_KINDS = ['allowed', 'range', 'lock'] as const
export type LimitKind = (typeof LIMIT_KINDS)[number]
export const LEGACY_ENCODES = ['zero_is_forever', 'zero_is_unlimited', 'minus_one_is_unlimited', 'fraction'] as const
export type LegacyEncode = (typeof LEGACY_ENCODES)[number]

/** A value as stored: a number, a flag, a word ("in_place", "unlimited", "prop.sku", "0.5%"). */
export type SettingValue = boolean | number | string

/** Values in force (or proposed), by setting key. */
export type Values = Record<string, SettingValue>

// ── The registry ────────────────────────────────────────────────────────────

export interface DefaultSpec {
    code: SettingValue
    /** The env var the deployment may set it with. */
    env: string | null
    /** The `versioning.config` attribute that reads it. */
    attr: string | null
}

export interface Effect {
    dimension: Dimension
    /** What raising the value does to this dimension. For a switch, turning it on; for a choice,
     *  the choices that do better on it. */
    up: string
    /** What lowering it does. */
    down: string
    weight: Weight
    /** Whether `up` is the better or the worse side for this dimension (`down` is the other). */
    upVerdict: Verdict
}

/** One moment of a choice's story: what readers see, and where it is read from. */
export interface Frame {
    when: 'before' | 'while' | 'after'
    shows: string
    source: 'graph store' | 'database'
    note: string
}

/** A condition for a setting, or one of its choices, to have any effect. */
export interface Requirement {
    feature: string | null
    setting: string | null
    oneOf: SettingValue[]
    graphFact: string | null
    /** A key of the registry's `why`. */
    why: string
}

export interface Choice {
    id: string
    title: string
    short: string
    promise: string
    effects: Partial<Record<Dimension, [Verdict, string]>>
    goodFor: string
    needs: string
    pros: string[]
    cons: string[]
    frames: Frame[]
    example: string
    requires: Requirement[]
    fallsBackTo: string | null
}

export interface Cap {
    setting: string | null
    /** An env var the deployment sets. */
    deployment: string | null
    enforced: boolean
    why: string
    /** System admins only, read when the schema was asked for: the ceiling, the deployment's or
     *  the capping setting's in force; null when it couldn't be read, and `problem` says why. */
    value?: SettingValue | null
    problem?: string | null
}

/** Checked on save: `this <op> other (± margin)`. */
export interface Rule {
    op: '<=' | '>='
    other: string
    margin: number
    message: string
}

export interface Recommended {
    value: SettingValue
    why: string
    /** From live facts, when the server had them: "your largest graph needs 13 GB free". */
    forThisPlatform: { value: SettingValue; why: string } | null
}

export interface Guidance {
    summary: string
    means: string
    effects: Effect[]
    changeWhen: string[]
    recommended: Recommended
    risk: Risk
    riskNote: string
    /** Problems this setting is one answer to. */
    symptoms: string[]
    /** Rendered on the server with the values in force. */
    example: string
    evidence: string
    aliases: string[]
}

export interface Legacy {
    buildPolicy: string | null
    residencyPolicy: string | null
    platformColumn: string | null
    workspaceColumn: string | null
    dataSourceColumn: string | null
    projectionStateColumn: string | null
    encode: LegacyEncode | null
}

export interface TakesEffect {
    when: TakesEffectWhen
    text: string
}

/** Limits a platform administrator sets on what lower scopes may choose, as the server stores them. */
export interface Limits {
    /** The choices lower scopes may pick. */
    allowed?: SettingValue[] | null
    /** The lowest and highest value they may set. */
    range?: [number, number] | null
    /** The same value for everyone: lower scopes' values are kept but ignored. */
    lock?: boolean | null
}

export interface Setting {
    key: string
    category: string
    label: string
    kind: Kind
    default: DefaultSpec
    /** Where a value may be chosen, and by whom. */
    scopes: Partial<Record<Scope, Editor>>
    takesEffect: TakesEffect
    guidance: Guidance
    audience: Audience
    /** The plain question the business lens asks. */
    question: string
    section: string | null
    range: [number, number] | null
    unit: string | null
    choices: Choice[]
    limitable: LimitKind[]
    defaultLimits: Limits
    requires: Requirement[]
    uses: string[]
    caps: Cap[]
    rules: Rule[]
    routing: boolean
    freshness: 'memo' | 'strict'
    unreadable: 'last_known' | 'skip'
    materialized: string | null
    visual: Visual | null
    legacy: Legacy | null
    /** Free-form presentation hints. */
    ui: Record<string, unknown>
    /** The guide page and anchor: "versioned-graph-settings#reads-mode". */
    docs: string
}

export interface Section {
    id: string
    title: string
}

export interface Category {
    id: string
    label: string
    summary: string
    /** A lucide icon name. */
    icon: string
    order: number
    audience: Audience[]
    /** The feature switch the whole category needs. */
    masterSwitch: string | null
    sections: Section[]
    /** Rendered on the server from the values in force: "Readers get …". */
    posture: string
}

export interface Term {
    term: string
    definition: string
    /** The engineering word, for Technical details. */
    technical: string
}

/** A one-click fix: turn a feature on, or set a setting. */
export interface WhyFix {
    feature?: string
    setting?: string
    to: SettingValue
}

export interface WhyText {
    text: string
    fix: WhyFix | null
}

/** A registry `Why`: the catalogue keys them by code (`why[code]`), so the code is the key. */
export type Why = WhyText

export interface DeploymentFact {
    env: string
    label: string
    category: string
    means: string
    attr: string | null
    /** How its value reads, as a setting's do. */
    kind: Kind
    unit: string | null
    /** System admins only, as config reads it when the schema was asked for; null when it
     *  couldn't be read, and `problem` says why. */
    value?: number | null
    /** Whether the deployment sets it (false: the default applies); null when not known. */
    set?: boolean | null
    problem?: string | null
}

export interface Retired {
    name: string
    why: string
}

/**
 * A one-click starting point: a value for each setting it covers, chosen for one outcome. Applying
 * one stages, at the level being edited, only the values the person may set there
 * (`applyProfile`); nothing is saved until the change is reviewed.
 */
export interface Profile {
    /** "fastest-reads": also its section's anchor in the guide. */
    id: string
    title: string
    /** One sentence: the outcome. */
    promise: string
    /** One plain line: the outcome as someone who wants it says it. The guided setup asks by it. */
    goal: string
    audience: Audience
    /** When to choose it. */
    when: string[]
    /** A value for each setting it covers, by key. */
    values: Values
    /** Where it can be applied. */
    scopes: Scope[]
    /** What you give up, in one sentence. It names each feature switch the profile needs. */
    caution: string
}

/** What actually happened: a counter the platform keeps, tied to the problem it is evidence of. */
export interface Signal {
    /** Fixed: the counters bump it by this id ("builds.waited_for_room"). */
    id: string
    /** What one count is, in plain words. */
    label: string
    /** One of its settings' `guidance.symptoms`: the finder shows the count beside this problem. */
    symptom: string
    /** The settings that drive it. */
    settings: string[]
    unit: string
    /** The count from which it is worth a look (set for 24 hours); null: only information. */
    warnAt: number | null
}

/** A signal's count over a window, as the signals API and a graph's health report it. */
export interface SignalCount {
    id: string
    count: number
    /** "1h", "24h" or "7d". */
    window: string
}

export interface DimensionInfo {
    id: Dimension
    label: string
}

export interface ScopeInfo {
    id: Scope
    label: string
}

export interface SettingsSchema {
    domain: string
    dimensions: DimensionInfo[]
    scopes: ScopeInfo[]
    categories: Category[]
    settings: Setting[]
    glossary: Term[]
    /** Why an effective value differs from the one chosen, by code. */
    why: Record<string, WhyText>
    deployment: DeploymentFact[]
    retired: Retired[]
    /** One-click starting points. */
    profiles: Profile[]
    /** The counters "Something's wrong?" shows beside the problems they answer. */
    signals: Signal[]
}

// ── The resolver's answer ───────────────────────────────────────────────────

export const STATUSES = ['in_effect', 'adjusted', 'dormant', 'not_used', 'locked', 'exception', 'invalid_env'] as const
export type Status = (typeof STATUSES)[number]

/** What the deployment's env var holds for a setting (the Default level's). */
export interface EnvReading {
    /** The env var. */
    name: string
    /** Its value: as read when it can't be this setting's (`valid` false). */
    value: SettingValue
    valid: boolean
    /** Set when the value is the right kind but out of range: the value held to the range. */
    held?: SettingValue
}

/** One level of the trail Default → Platform → Workspace → Graph. */
export interface TrailStep {
    scope: TrailScope
    /** The value chosen at this level; null when it chose none. */
    value: SettingValue | null
    /** Default only: the deployment's env value, when it sets one of its own. */
    env?: EnvReading | null
    /** Platform only: lower scopes' values are ignored. */
    locked?: boolean
    /** Platform only: what lower scopes may choose. */
    limits?: Limits | null
    /** Workspace or graph: a system administrator's value outside the limits, kept in force. */
    exception?: boolean
}

export interface WhyItem {
    code: string
    text: string
    fix: WhyFix | null
}

export interface ResolvedSetting {
    key: string
    /** The value in force. */
    effective: SettingValue
    /** The value chosen at the winning level, before caps and fallbacks. */
    declared: SettingValue | null
    /** The level the value came from: `env` when the deployment's env var set the default. */
    source: TrailScope | 'env'
    trail: TrailStep[]
    status: Status
    why: WhyItem[]
    /** Whether the viewer may change it at this scope. */
    editable: boolean
    /** Who may change it at this scope. */
    editor: Editor | null
    /** What the viewer may choose at this scope: a choice's ids, or a ranged number's bounds. */
    allowed: SettingValue[] | { min: number; max: number } | null
    /** For optimistic concurrency: send it back as `expectedVersion`. */
    version: number
    /** The platform only: the limits saved for lower levels; null: the setting's default limits. */
    limits?: Limits | null
}

export type ResolvedValues = Record<string, ResolvedSetting>

// ── Live facts the explainers draw (not part of the registry) ───────────────
// From the residency preview, the inventory and an import's dry run; the page that shows a visual
// passes what it has.

/** One graph store node's memory. */
export interface NodeMemory {
    id: string
    label: string
    usedBytes: number
    maxBytes: number
}

/** The counts an import's dry run reports, for the replace guard. */
export interface SampleImport {
    /** Items in the graph now. */
    liveItems: number
    /** Rows in the file. */
    importRows: number
    /** Rows that matched an existing item. */
    matched: number
    deletes: number
    creates: number
}

export interface SettingsFacts {
    nodes?: NodeMemory[]
    /** Named by its data source; null when it can't be named. */
    largestGraph?: { name: string | null; bytes: number }
    sampleImport?: SampleImport
}
