/**
 * The resolver's answer at three scopes, over the real registry (schema.ts), shaped like the values
 * API. The why texts are the registry's own.
 *
 * - `PLATFORM_VALUES`: a system admin on the platform. New-version builds are off, so every
 *   builds.* setting is dormant (and builds per worker is also capped by the deployment); the
 *   deployment's read timeout is invalid; the versions-behind limit is not used under Always the
 *   latest; the replace guard is locked on.
 * - `WORKSPACE_VALUES`: a workspace admin on "Finance". A system admin kept closed drafts forever
 *   and allowed 50 forks, both outside the platform's limits: exceptions.
 * - `GRAPH_VALUES`: a workspace admin on the graph "Sales lineage". Its "switch when ready" is
 *   adjusted to update in place (builds are off), the replace guard is locked by the platform, the
 *   new-draft visibility is decided by the workspace's draft levels, and its residency class is a
 *   system admin's to change.
 *
 * `FACTS` are the live figures the explainers draw.
 */
import type { ResolvedSetting, ResolvedValues, SettingsFacts, SettingValue, SignalCount, TrailStep, WhyItem } from '../types'
import { SCHEMA, SETTINGS_BY_KEY } from './schema'

const GB = 1024 ** 3

const why = (code: string, fix: WhyItem['fix'] = SCHEMA.why[code]?.fix ?? null, text = SCHEMA.why[code]?.text ?? code): WhyItem => ({ code, text, fix })

/** The registry's generic text, with the fix the resolver fills in from the setting's requirement. */
const BUILDS_OFF = why('switch_off', { feature: 'candidateKeysEnabled', to: true })

function resolve(key: string, r: Partial<ResolvedSetting> & { trail: TrailStep[] }): ResolvedSetting {
    // The winner: the most specific level with a value (a locked platform wins outright).
    const platform = r.trail.find((t) => t.scope === 'platform')
    const winner = platform?.locked ? platform : [...r.trail].reverse().find((t) => t.value !== null) ?? r.trail[0]
    const s = SETTINGS_BY_KEY[key]
    return {
        key,
        effective: winner.value as SettingValue,
        declared: winner.value,
        source: winner.scope,
        status: 'in_effect',
        why: [],
        editable: true,
        editor: 'system_admin',
        allowed: s.kind === 'choice' ? s.choices.map((c) => c.id) : null,
        version: 1,
        ...r,
    }
}

const dflt = (key: string, env: SettingValue | null = null): TrailStep => ({ scope: 'default', value: SETTINGS_BY_KEY[key].default.code, env })

// ── Platform: a system admin ────────────────────────────────────────────────

/** The platform's own values (the rest are the defaults). schema.ts's live parts were rendered with these. */
const PLATFORM_CHOSEN: Record<string, SettingValue> = {
    'builds.copyRoomPct': 250,
    'builds.perWorker': 4,
    'residency.standardIdleSecs': 1209600,
    'updates.readPressureRatio': 2.5,
    'imports.guardMinLive': 5000,
}

const PLATFORM_LIMITS: Record<string, TrailStep['limits']> = {
    'reads.mode': { allowed: ['latest', 'in_place'] },
    'drafts.keepClosedDays': { min: 1, max: 90 },
    'forks.maxPerGraph': { min: 0, max: 20 },
}

export const PLATFORM_VALUES: ResolvedValues = Object.fromEntries(SCHEMA.settings.map((s, i) => {
    const step: TrailStep = { scope: 'platform', value: PLATFORM_CHOSEN[s.key] ?? null, locked: s.key === 'imports.replaceGuard', limits: PLATFORM_LIMITS[s.key] ?? null }
    if (s.key === 'imports.replaceGuard') step.value = true
    let r = resolve(s.key, { trail: [dflt(s.key), step], version: 1 + (i % 4) })
    if (s.category === 'builds') {
        r = { ...r, status: 'dormant', why: [BUILDS_OFF] }
        if (s.key === 'builds.perWorker') r.why = [BUILDS_OFF, why('capped_by_deployment')]
    }
    if (s.key === 'reads.maxVersionsBehind') r = { ...r, status: 'not_used', why: [why('not_used_by_mode')] }
    if (s.key === 'database.readTimeoutMs') {
        r = { ...r, trail: [dflt(s.key, 'thirty seconds'), step], status: 'invalid_env', why: [why('invalid_env')] }
    }
    return [s.key, r]
}))

// ── Workspace "Finance": a workspace admin ──────────────────────────────────

const platformStep = (key: string): TrailStep => PLATFORM_VALUES[key].trail.find((t) => t.scope === 'platform')!

const ws = (key: string, value: SettingValue | null, r: Partial<ResolvedSetting> = {}): ResolvedSetting => {
    const s = SETTINGS_BY_KEY[key]
    return resolve(key, {
        trail: [dflt(key), platformStep(key), { scope: 'workspace', value, exception: r.status === 'exception' }],
        editor: s.scopes.workspace ?? null,
        editable: s.scopes.workspace === 'workspace_admin',
        version: 2,
        ...r,
    })
}

export const WORKSPACE_VALUES: ResolvedValues = {
    'reads.mode': ws('reads.mode', 'in_place', { allowed: ['latest', 'in_place'] }),
    'reads.maxVersionsBehind': ws('reads.maxVersionsBehind', 3),
    'residency.class': ws('residency.class', null),
    'drafts.keepClosedDays': ws('drafts.keepClosedDays', 'forever', {
        status: 'exception',
        why: [why('outside_limits_exception')],
    }),
    'drafts.idleCloseDays': ws('drafts.idleCloseDays', null),
    'drafts.levels': ws('drafts.levels', 'public_only'),
    'drafts.defaultVisibility': ws('drafts.defaultVisibility', null),
    'drafts.selfApproval': ws('drafts.selfApproval', false),
    'forks.maxPerGraph': ws('forks.maxPerGraph', 50, {
        status: 'exception',
        why: [why('outside_limits_exception')],
    }),
    'trash.restoreDays': ws('trash.restoreDays', 14),
    'imports.identifier': ws('imports.identifier', null),
    'imports.replaceGuard': ws('imports.replaceGuard', null, { status: 'locked', editable: false, why: [why('locked_by_platform')] }),
    'imports.guardDeleteShare': ws('imports.guardDeleteShare', 0.25),
    'imports.maxRefusedRows': ws('imports.maxRefusedRows', '0.5%'),
}

// ── Graph "Sales lineage" in Finance: a workspace admin ─────────────────────

const wsStep = (key: string): TrailStep =>
    WORKSPACE_VALUES[key]?.trail.find((t) => t.scope === 'workspace') ?? { scope: 'workspace', value: null }

const graph = (key: string, value: SettingValue | null, r: Partial<ResolvedSetting> = {}): ResolvedSetting => {
    const s = SETTINGS_BY_KEY[key]
    return resolve(key, {
        trail: [dflt(key), platformStep(key), wsStep(key), { scope: 'graph', value, exception: false }],
        editor: s.scopes.graph ?? null,
        editable: s.scopes.graph === 'workspace_admin',
        version: 3,
        ...r,
    })
}

export const GRAPH_VALUES: ResolvedValues = {
    // The contract's own example: "switch when ready" chosen, updating in place while builds are off.
    'reads.mode': graph('reads.mode', 'beside', {
        effective: 'in_place',
        status: 'adjusted',
        why: [why('builds_off')],
        allowed: ['latest', 'in_place'],
        trail: [
            { scope: 'default', value: 'latest', env: null },
            { scope: 'platform', value: 'latest', locked: false, limits: { allowed: ['latest', 'in_place', 'beside'] } },
            { scope: 'workspace', value: null },
            { scope: 'graph', value: 'beside', exception: false },
        ],
    }),
    'reads.maxVersionsBehind': graph('reads.maxVersionsBehind', null),
    'residency.class': graph('residency.class', 'coldline'),
    'drafts.levels': graph('drafts.levels', null),
    'drafts.defaultVisibility': graph('drafts.defaultVisibility', 'private', {
        effective: 'public',
        status: 'adjusted',
        why: [why('derived_from_levels')],
    }),
    'drafts.selfApproval': graph('drafts.selfApproval', null),
    'forks.maxPerGraph': graph('forks.maxPerGraph', null, {
        status: 'exception',
        why: [why('outside_limits_exception')],
    }),
    'imports.identifier': graph('imports.identifier', 'prop.sku'),
    'imports.replaceGuard': graph('imports.replaceGuard', false, {
        status: 'locked',
        editable: false,
        why: [why('locked_by_platform')],
    }),
    'imports.guardMinLive': graph('imports.guardMinLive', null),
    'imports.guardDeleteShare': graph('imports.guardDeleteShare', 0.3),
    'imports.guardCreateShare': graph('imports.guardCreateShare', null),
    'imports.minMatchShare': graph('imports.minMatchShare', null),
    'imports.maxRefusedRows': graph('imports.maxRefusedRows', null),
}

// ── Live facts ──────────────────────────────────────────────────────────────

export const FACTS: SettingsFacts = {
    nodes: [
        { id: 'node-1', label: 'Node 1', usedBytes: 9.1 * GB, maxBytes: 12 * GB },
        { id: 'node-2', label: 'Node 2', usedBytes: 3.2 * GB, maxBytes: 16 * GB },
        { id: 'node-3', label: 'Node 3', usedBytes: 10.8 * GB, maxBytes: 12 * GB },
    ],
    largestGraph: { name: 'Sales lineage', bytes: 9.4 * GB },
    sampleImport: { liveItems: 120000, importRows: 118500, matched: 96000, deletes: 24000, creates: 22500 },
}

/**
 * What happened on this platform in the last 24 hours, as the signals API counts it. New-version
 * builds are off here, so nothing was built; loads waited past their mark (30) and one replace was
 * stopped by the guard (mark 1), while retries (12 of 50) and unloads (4 of 10) stayed under theirs.
 */
export const SIGNAL_COUNTS: SignalCount[] = [
    { id: 'builds.waited_for_room', count: 0, window: '24h' },
    { id: 'builds.copy_timed_out', count: 0, window: '24h' },
    { id: 'builds.dropped', count: 0, window: '24h' },
    { id: 'reads.asked_to_retry', count: 12, window: '24h' },
    { id: 'reads.from_database_while_behind', count: 1840, window: '24h' },
    { id: 'residency.unloaded_under_pressure', count: 4, window: '24h' },
    { id: 'residency.load_waited_for_room', count: 38, window: '24h' },
    { id: 'imports.replace_refused_by_guard', count: 1, window: '24h' },
    { id: 'imports.replace_stopped_low_match', count: 0, window: '24h' },
    { id: 'drafts.idle_closed', count: 3, window: '24h' },
    { id: 'drafts.changes_removed', count: 5, window: '24h' },
]
