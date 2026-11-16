/**
 * The settings API as this section's tests and harness see it: each answer in the shape the server
 * sends, built from the settings kit's fixtures (`components/settings/__fixtures__`), so every
 * label, choice and why is the registry's own.
 *
 *   values      the platform's (with saved limits), the workspace "Finance"'s and a graph's, every
 *               setting, as a list, for whoever is looking (a system admin, a workspace admin, a
 *               viewer)
 *   inventory   eight graphs: platform copies and connected graphs, a fork, an orphan, unloaded,
 *               loading, waiting for room, failing and building beside
 *   workspace   Finance's graphs, each with what it sets itself (a fork among them), and its history
 *   history     four change sets: a save, a workspace's, one carried over, a change of limits
 *   preview     answered from the values: each staged value in force, "switch when ready" held to
 *               "update in place" while builds are off; the full preview's impact
 *   health      a graph's, with one part the server couldn't read
 *   versioning  what a data source's Versioning tab reads: its graph, drafts, history, forks, where
 *               the graph lives (the watermark, with the read mode in force and why) and its imports
 */
import { SCHEMA, SETTINGS_BY_KEY } from '@/components/settings/__fixtures__/schema'
import { FACTS, GRAPH_VALUES, PLATFORM_VALUES, WORKSPACE_VALUES } from '@/components/settings/__fixtures__/resolved'
import { sameLimits } from '@/components/settings/format'
import type { Editor, ResolvedSetting, ResolvedValues, TrailStep } from '@/components/settings/types'
import type { PatchItem } from '@/components/settings/useStagedChanges'
import type { VersionedGraphRow } from '@/services/systemStatusService'
import type { ImportSettings } from '@/services/importExportApiService'
import type { Watermark } from '@/services/versioningApiService'
import type { GraphHealth, GraphsSummary, HistoryEntry, Impact, WorkspaceGraph } from '@/services/settingsService'

export { SCHEMA, SETTINGS_BY_KEY }

export const WS = 'ws_finance'
export const GRAPH = 'graph_sales'
export const ROOT = 'graph_root'

// ── Values ──────────────────────────────────────────────────────────────────

const platformStep = (r: ResolvedSetting) => r.trail.find((t) => t.scope === 'platform')

/** The platform's values: each with the limits saved for lower levels (null: the defaults). */
export function platformValues(editor: Editor | null = 'system_admin') {
    return {
        scope: 'platform',
        editor,
        values: Object.values(PLATFORM_VALUES).map((r) => {
            const limits = platformStep(r)?.limits ?? null
            const saved = limits && !sameLimits(limits, SETTINGS_BY_KEY[r.key].defaultLimits) ? limits : null
            return editor === 'system_admin' ? { ...r, limits: saved } : { ...r, limits: saved, editable: false, editor: 'system_admin', allowed: null }
        }),
        version: 12,
    }
}

/**
 * A graph's values, every setting: the kit's graph fixture where it has one, else the platform's
 * answer walked down to the graph (a setting a graph can't have stops where its scopes do).
 */
export function graphValues(viewer: Editor = 'workspace_admin') {
    const values = SCHEMA.settings.map((s): ResolvedSetting => {
        const may = s.scopes.graph ?? null
        const editable = may !== null && (viewer === 'system_admin' || may === 'workspace_admin')
        const own = GRAPH_VALUES[s.key]
        if (own) return { ...own, editable: own.status === 'locked' ? false : editable, editor: may }
        const p = PLATFORM_VALUES[s.key]
        const below: TrailStep[] = [
            ...(s.scopes.workspace ? [{ scope: 'workspace' as const, value: null }] : []),
            ...(s.scopes.graph ? [{ scope: 'graph' as const, value: null, exception: false }] : []),
        ]
        return {
            ...p,
            trail: [...p.trail, ...below],
            editable,
            editor: may,
            allowed: editable && s.kind === 'choice' ? s.choices.map((c) => c.id) : null,
            version: 0,
        }
    })
    return { scope: 'graph', workspaceId: WS, graphId: GRAPH, dataSourceId: 'ds_sales', editor: viewer, values, version: 31 }
}

/**
 * The workspace Finance's values, every setting, for `viewer` (null: someone who may only read): the
 * kit's workspace fixture where it has one, else the platform's answer walked down to the
 * workspace. A workspace admin may choose within the platform's limits (switch when ready isn't
 * offered; the replace guard is locked); a system admin may go past them, and set the class.
 */
export function workspaceValues(viewer: Editor | null = 'workspace_admin') {
    const values = SCHEMA.settings.map((s): ResolvedSetting => {
        const may = s.scopes.workspace ?? null
        const base = WORKSPACE_VALUES[s.key]
        const p = PLATFORM_VALUES[s.key]
        const platform = p.trail.find((t) => t.scope === 'platform')
        const limits = platform?.limits
        const editable = may !== null && !platform?.locked
            && (viewer === 'system_admin' || (viewer === 'workspace_admin' && may === 'workspace_admin'))
        const bound = viewer === 'workspace_admin'
        const allowed = !editable ? null
            : s.kind === 'choice' ? s.choices.map((c) => c.id).filter((id) => !bound || !limits?.allowed || limits.allowed.includes(id))
                : s.range ? {
                    min: bound && limits?.range ? Math.max(s.range[0], limits.range[0]) : s.range[0],
                    max: bound && limits?.range ? Math.min(s.range[1], limits.range[1]) : s.range[1],
                } : null
        if (base) return { ...base, editable, editor: may, allowed }
        return {
            ...p,
            trail: [...p.trail, ...(may ? [{ scope: 'workspace' as const, value: null }] : [])],
            editable,
            editor: may,
            allowed,
            version: 0,
        }
    })
    return { scope: 'workspace', workspaceId: WS, editor: viewer, values, version: 18 }
}

// ── Preview ─────────────────────────────────────────────────────────────────

/** What the server would answer for `changes` at the platform, or at `base`'s place (quick, or full with the impact). */
export function preview(changes: PatchItem[], mode: 'quick' | 'full', base: ResolvedValues = PLATFORM_VALUES) {
    const values = changes.flatMap((c) => {
        const r = base[c.key]
        if (!r || !('value' in c)) return []
        const s = SETTINGS_BY_KEY[c.key]
        const chosen = c.value ?? r.trail[0].value ?? r.effective
        // Switch when ready needs New-version builds, which the fixture has off.
        const held = c.key === 'reads.mode' && chosen === 'beside'
        return [{
            ...r,
            effective: held ? 'in_place' : chosen,
            declared: chosen,
            status: held ? 'adjusted' : 'in_effect',
            why: held ? [{ code: 'builds_off', text: SCHEMA.why.builds_off?.text ?? '', fix: SCHEMA.why.builds_off?.fix ?? null }] : [],
            example: s.guidance.example,
        }]
    })
    const out: { scope: string; mode: string; values: unknown[]; impact?: Impact } = { scope: 'platform', mode, values }
    if (mode === 'full') out.impact = impact(changes)
    return out
}

type OutsideValue = NonNullable<Impact['outsideLimits']>['samples'][number]

/** What workspaces and graphs chose for themselves: what staged limits are checked against. */
const CHOSEN_BELOW: Array<Omit<OutsideValue, 'status'>> = [
    { key: 'reads.mode', scope: 'workspace', scopeId: WS, value: 'beside' },
    { key: 'reads.mode', scope: 'graph', scopeId: 'ds_sales', value: 'beside' },
    { key: 'reads.mode', scope: 'graph', scopeId: 'ds_pay', value: 'latest' },
]

/** The values staged limits leave outside them: ignored under a lock, else kept as exceptions. */
function outsideLimits(changes: PatchItem[]): Impact['outsideLimits'] {
    const samples = changes.flatMap(({ key, limits }): OutsideValue[] => (limits ? CHOSEN_BELOW.filter((v) => v.key === key).flatMap((v): OutsideValue[] => {
        if (limits.lock) return [{ ...v, status: 'locked' }]
        return limits.allowed && !limits.allowed.includes(v.value) ? [{ ...v, status: 'exception' }] : []
    }) : []))
    return samples.length ? { count: samples.length, locked: samples.filter((v) => v.status === 'locked').length, samples } : null
}

export function impact(changes: PatchItem[]): Impact {
    const keys = new Set(changes.map((c) => c.key))
    const memory = ['builds.copyRoomPct', 'residency.unloadStartPct'].some((k) => keys.has(k))
    const GB = 1024 ** 3
    return {
        graphs: {
            inScope: 42,
            changed: keys.has('reads.mode') ? 7 : 0,
            samples: keys.has('reads.mode') ? [
                { graphId: 'graph_orders', dataSourceId: 'ds_orders', workspaceId: WS, label: 'Orders', changes: [{ key: 'reads.mode', from: 'latest', to: 'in_place' }] },
                { graphId: 'graph_payments', dataSourceId: 'ds_pay', workspaceId: WS, label: 'Payments', changes: [{ key: 'reads.mode', from: 'latest', to: 'in_place' }] },
            ] : [],
        },
        alwaysLatest: keys.has('reads.mode') ? { joining: 0, leaving: 7 } : null,
        memory: memory ? {
            largestGraphBytes: 9.4 * GB,
            neededBytes: { from: 23.5 * GB, to: 23.5 * GB },
            copied: true,
            nodes: (FACTS.nodes ?? []).map((n) => ({ name: n.label, usedBytes: n.usedBytes, maxBytes: n.maxBytes, freeBytes: n.maxBytes * 0.85 - n.usedBytes, fits: false })),
        } : null,
        residency: keys.has('residency.unloadStartPct') ? {
            switchOn: true, unloads: 0, unloadedBytes: 0, loads: 1, waits: 0,
            nodes: [{ name: 'falkordb-2:6379', usedBytes: 3.2 * GB, maxBytes: 16 * GB, usedAfterBytes: 4.1 * GB, unloads: [], loads: [{ label: 'Orders', bytes: 0.9 * GB }], waits: [] }],
        } : null,
        database: null,
        drafts: keys.has('drafts.keepClosedDays') ? { workspaces: 3, removedAtNextSweep: 18 } : null,
        outsideLimits: outsideLimits(changes),
        warnings: keys.has('drafts.keepClosedDays')
            ? [{ code: 'drafts_removed', key: 'drafts.keepClosedDays', text: 'The next sweep removes the changes of 18 closed drafts, and that can’t be undone.' }]
            : [],
        unavailable: [],
    }
}

// ── The fleet ───────────────────────────────────────────────────────────────

export function row(over: Partial<VersionedGraphRow>): VersionedGraphRow {
    return {
        graphId: 'graph_a', workspaceId: WS, workspaceName: 'Finance', dataSourceId: 'ds1',
        dataSourceLabel: 'Customer 360', providerName: 'Primary', providerType: 'falkordb', kind: 'manual',
        falkorGraphName: 'customer_360', falkorProvider: 'falkor-eu', committed: 3, projected: 3, target: 3,
        lag: 0, status: 'idle', lastError: null, lastProjectedAt: '2026-11-16T15:58:00Z', progressDone: null, progressTotal: null,
        updatedAt: null, owned: false, forkParentGraphId: null, orphan: false, retiredKeys: [],
        residency: 'standard', residencyState: 'resident', evictedReason: null, lastReadAt: '2026-11-16T16:20:00Z',
        sizeBytes: 812 * 1024 ** 2, rehydratingSince: null, readMode: null, readModeEffective: 'latest',
        ...over,
    } as VersionedGraphRow
}

export const GRAPHS: VersionedGraphRow[] = [
    row({ graphId: GRAPH, dataSourceId: 'ds_sales', dataSourceLabel: 'Sales lineage', falkorGraphName: 'gvp_graph_sales{les.3}', owned: true,
        residency: 'coldline', readMode: 'beside', readModeEffective: 'in_place', sizeBytes: 9.4 * 1024 ** 3 }),
    row({}),
    row({ graphId: 'graph_orders', dataSourceId: 'ds_orders', dataSourceLabel: 'Orders', falkorGraphName: 'gvp_graph_orders{ers.1}', owned: true,
        residency: 'coldline', residencyState: 'evicted', status: 'evicted', evictedReason: 'idle_coldline', lastReadAt: '2026-11-14T09:00:00Z' }),
    row({ graphId: 'graph_payments', dataSourceId: 'ds_pay', dataSourceLabel: 'Payments', falkorGraphName: 'gvp_graph_payments{nts.1}', owned: true,
        readMode: 'latest', readModeEffective: 'latest', residency: 'always' }),
    row({ graphId: 'graph_ledger', dataSourceId: 'ds_ledger', dataSourceLabel: 'Ledger', falkorGraphName: 'gvp_graph_ledger{ger.2}', owned: true,
        readModeEffective: 'beside', build: { step: 'seeding', reason: 'rebuild', rebuild: 'operator', progress: { done: 41_000, total: 100_000 } } }),
    row({ graphId: 'graph_ship', dataSourceId: 'ds_ship', dataSourceLabel: 'Shipments', falkorGraphName: 'gvp_graph_ship{hip.1}', owned: true,
        residencyState: 'waiting_capacity', status: 'waiting_capacity', lag: 3, committed: 9, projected: 6 }),
    row({ graphId: 'graph_fork', dataSourceId: 'dsfork_7', dataSourceLabel: null, falkorGraphName: 'gv_graph_fork', owned: true,
        forkParentGraphId: GRAPH, residency: null, residencyState: null, readModeEffective: null, sizeBytes: null, lastReadAt: null }),
    row({ graphId: 'graph_old', dataSourceId: 'ds_gone', dataSourceLabel: null, workspaceName: null, falkorGraphName: 'old_key', orphan: true,
        lastError: 'connection refused by falkordb-1:6379', residencyState: 'evicted', sizeBytes: null }),
]

export const SUMMARY: GraphsSummary = {
    graphs: 42, inMemory: 35, unloaded: 4, loading: 1, waitingForRoom: 2, building: 2, failing: 1, withOwnSettings: 7,
}

export const PROVIDERS = [
    { id: 'falkor-eu', name: 'EU graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true, versionedGraphs: 31 },
    { id: 'falkor-us', name: 'US graph store', type: 'falkordb', status: 'healthy', error: null, isActive: true, versionedGraphs: 11 },
]

/** Each node's memory, as the residency preview of no change reports it. */
export const MASTERS = {
    masters: (FACTS.nodes ?? []).map((n, i) => ({ endpoint: `falkordb-${i}:6379`, usedBytes: n.usedBytes, maxBytes: n.maxBytes })),
}

// ── History ─────────────────────────────────────────────────────────────────

const entry = (over: Partial<HistoryEntry> & Pick<HistoryEntry, 'id' | 'changeSetId' | 'key'>): HistoryEntry => ({
    at: '2026-11-16T14:05:00Z', actor: { id: 'usr_ada', name: 'Ada Lovelace' }, reason: null, source: 'api', scope: 'platform', scopeId: '',
    from: { value: null, limits: null }, to: { value: null, limits: null }, version: 2, ...over,
})

export const HISTORY: HistoryEntry[] = [
    entry({ id: 41, changeSetId: 'cs_4', key: 'reads.mode', at: '2026-11-16T15:40:00Z', reason: 'Let teams choose switch when ready for big nightly imports',
        from: { value: null, limits: { allowed: ['latest', 'in_place'] } }, to: { value: null, limits: { allowed: ['latest', 'in_place', 'beside'] } } }),
    entry({ id: 40, changeSetId: 'cs_3', key: 'reads.mode', reason: 'Large imports were slowing canvases for the sales team',
        from: { value: null, limits: null }, to: { value: 'in_place', limits: null } }),
    entry({ id: 39, changeSetId: 'cs_3', key: 'residency.unloadStartPct', reason: 'Large imports were slowing canvases for the sales team',
        from: { value: null, limits: null }, to: { value: 85, limits: null } }),
    entry({ id: 30, changeSetId: 'cs_2', key: 'drafts.keepClosedDays', at: '2026-11-12T10:12:00Z', actor: { id: 'usr_grace', name: 'Grace Hopper' },
        reason: 'Finance keeps closed drafts for its audits', scope: 'workspace', scopeId: WS, from: { value: 30, limits: null }, to: { value: 'forever', limits: null } }),
    entry({ id: 12, changeSetId: 'cs_1', key: 'imports.guardMinLive', at: '2026-11-02T08:00:00Z', actor: null, source: 'migration',
        reason: 'Carried over from the import settings', from: { value: null, limits: null }, to: { value: 5000, limits: null } }),
]

// ── A graph's health ────────────────────────────────────────────────────────

export const HEALTH: GraphHealth = {
    asOf: '2026-11-16T16:24:00Z',
    head: { seq: 214, version: { commitId: 'cm_214', at: '2026-11-16T16:21:00Z', actor: { id: 'usr_alice', name: 'Alice Martin' }, message: 'Q4 import' } },
    serving: { seq: 213, version: { commitId: 'cm_213', at: '2026-11-16T15:02:00Z', actor: { id: 'usr_alice', name: 'Alice Martin' }, message: 'Q3 corrections' }, source: 'graph_store' },
    versionsBehind: 1,
    readMode: {
        effective: 'in_place', declared: 'beside', source: 'graph',
        why: [{ code: 'builds_off', text: SCHEMA.why.builds_off?.text ?? '', fix: SCHEMA.why.builds_off?.fix ?? null }],
    },
    lastUpdate: { finishedAt: '2026-11-16T16:21:30Z', durationSecs: 42, rows: 18_400, ratePerSec: 438 },
    memory: { bytes: 9.4 * 1024 ** 3, node: 'falkordb-2:6379', loaded: true, class: 'coldline', lastReadAt: '2026-11-16T16:23:10Z' },
    lastBuild: null,
    signals: [{ id: 'reads.from_database_while_behind', count24h: 12 }, { id: 'builds.waited_for_room', count24h: 0 }],
    problems: [{ part: 'lastBuild', message: 'The build record couldn’t be read: it was being written at the time.' }],
}

// ── Features ────────────────────────────────────────────────────────────────

export const FEATURES = {
    schema: [
        { key: 'versioningEnabled', name: 'Version control', description: '', category: 'lineage', type: 'boolean', default: true },
        { key: 'candidateKeysEnabled', name: 'New-version builds', description: '', category: 'lineage', type: 'boolean', default: false,
            impactWhenOn: 'A large publish is built in a second copy while readers keep the current version, then they switch to it.',
            impactWhenOff: 'Every change is written into the copy that serves reads, as before.', dependsOn: ['versioningEnabled'] },
        { key: 'residencyEnabled', name: 'Graph residency', description: '', category: 'lineage', type: 'boolean', default: false,
            impactWhenOn: 'The graph store keeps each graph by its class and each node’s memory.',
            impactWhenOff: 'Every graph stays loaded, as before residency.', dependsOn: ['versioningEnabled'] },
    ],
    values: { versioningEnabled: true, candidateKeysEnabled: false, residencyEnabled: true },
    version: 7,
    lastChanges: { residencyEnabled: { from: false, to: true, actorName: 'Ada Lovelace', at: '2026-11-10T09:30:00Z' } },
}

// ── A workspace's graphs and history ────────────────────────────────────────

const brief = (key: string, over: Partial<WorkspaceGraph['readMode']> = {}): WorkspaceGraph['readMode'] => {
    const r = GRAPH_VALUES[key] ?? PLATFORM_VALUES[key]
    return { effective: r.effective, declared: r.declared, source: r.source, status: r.status, why: r.why, ...over }
}

/** Finance's graphs: Sales lineage sets five values itself, Payments two, Orders none; a fork follows Sales lineage. */
export const WORKSPACE_GRAPHS: WorkspaceGraph[] = [
    { graphId: 'graph_orders', dataSourceId: 'ds_orders', label: 'Orders', follows: null, ownSettings: [],
        readMode: brief('reads.mode', { effective: 'in_place', declared: 'in_place', source: 'workspace', status: 'in_effect', why: [] }),
        residencyClass: brief('residency.class', { effective: 'standard', declared: 'standard', source: 'default', status: 'in_effect', why: [] }) },
    { graphId: 'graph_payments', dataSourceId: 'ds_pay', label: 'Payments', follows: null, ownSettings: ['reads.mode', 'residency.class'],
        readMode: brief('reads.mode', { effective: 'latest', declared: 'latest', source: 'graph', status: 'in_effect', why: [] }),
        residencyClass: brief('residency.class', { effective: 'always', declared: 'always', source: 'graph', status: 'in_effect', why: [] }) },
    { graphId: GRAPH, dataSourceId: 'ds_sales', label: 'Sales lineage', follows: null,
        ownSettings: ['drafts.defaultVisibility', 'imports.guardDeleteShare', 'imports.identifier', 'reads.mode', 'residency.class'],
        readMode: brief('reads.mode'), residencyClass: brief('residency.class') },
    { graphId: 'graph_fork', dataSourceId: 'dsfork_7', label: 'Sales lineage · Q4 what-if', follows: { graphId: GRAPH, dataSourceId: 'ds_sales' },
        ownSettings: [], readMode: brief('reads.mode'), residencyClass: brief('residency.class') },
]

/** Finance's history: its own changes and its graphs', newest first. */
export const WORKSPACE_HISTORY: HistoryEntry[] = [
    entry({ id: 52, changeSetId: 'cs_w3', key: 'imports.identifier', at: '2026-11-16T11:20:00Z', actor: { id: 'usr_alice', name: 'Alice Martin' },
        reason: 'Sales rows carry their SKU', scope: 'graph', scopeId: 'ds_sales', from: { value: null, limits: null }, to: { value: 'prop.sku', limits: null }, version: 3 }),
    entry({ id: 51, changeSetId: 'cs_w2', key: 'reads.mode', at: '2026-11-15T09:05:00Z', actor: { id: 'usr_grace', name: 'Grace Hopper' },
        reason: 'Nightly imports were slowing the finance canvases', scope: 'workspace', scopeId: WS,
        from: { value: 'latest', limits: null }, to: { value: 'in_place', limits: null } }),
    entry({ id: 30, changeSetId: 'cs_2', key: 'drafts.keepClosedDays', at: '2026-11-12T10:12:00Z', actor: { id: 'usr_grace', name: 'Grace Hopper' },
        reason: 'Finance keeps closed drafts for its audits', scope: 'workspace', scopeId: WS, from: { value: 30, limits: null }, to: { value: 'forever', limits: null } }),
    entry({ id: 14, changeSetId: 'cs_w1', key: 'drafts.levels', at: '2026-11-02T08:00:00Z', actor: null, source: 'migration',
        reason: 'Carried over from the drafts and reviews policy', scope: 'workspace', scopeId: WS,
        from: { value: null, limits: null }, to: { value: 'public_only', limits: null } }),
]

// ── A data source's Versioning tab ──────────────────────────────────────────

/** The data source Sales lineage's graph, as the tab resolves it. */
export const RESOLVED = { graphId: GRAPH, mainBranchId: 'br_main', mainHeadCommitSeq: 214, kind: 'bootstrap', lifecycleState: 'live', lifecycleRev: 3 }

export const BRANCHES = [
    { branchId: 'br_main', kind: 'main', name: 'main', status: 'open', createdAt: '2026-10-01T09:00:00Z', updatedAt: '2026-11-16T16:21:00Z' },
    { branchId: 'br_q4', kind: 'draft', name: 'Q4 price corrections', status: 'open', owner: 'usr_alice', userNames: { usr_alice: 'Alice Martin' },
        createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-16T12:00:00Z' },
]

export const COMMITS = {
    commits: [
        { commit_id: 'cm_214', commit_seq: 214, kind: 'import', message: 'Q4 import', actor: 'usr_alice', actor_kind: 'human', automation: false,
            created_at: '2026-11-16T16:21:00Z', stats: { create: 1200, update: 16_900, delete: 300 } },
        { commit_id: 'cm_213', commit_seq: 213, kind: 'squash_publish', message: 'Q3 corrections', actor: 'usr_alice', actor_kind: 'human', automation: false,
            created_at: '2026-11-16T15:02:00Z', stats: { create: 0, update: 42, delete: 1 } },
    ],
    userNames: { usr_alice: 'Alice Martin' },
}

export const FORKS = [
    { graphId: 'graph_fork', workspaceId: WS, kind: 'fork', forkParentGraphId: GRAPH, forkBaseCommitSeq: 210, mainHeadCommitSeq: 4,
        createdBy: 'usr_alice', createdAt: '2026-11-10T09:00:00Z', purging: false, userNames: { usr_alice: 'Alice Martin' },
        dataSourceId: 'dsfork_7', label: 'Sales lineage · Q4 what-if', ahead: 4, behind: 2, updateRecommended: false, readsFrom: 'overlay', countsCapped: false },
]

/** Where the graph lives, and the read mode in force with why, as a server that resolves it through the settings says. */
export const WATERMARK: Watermark = {
    committed: 214, projected: 213, fresh: false, served: 213, status: 'projecting', target: 214,
    projectionKey: 'gvp_graph_sales{les.3}', providerId: 'falkor-eu', providerName: 'EU graph store', owned: true,
    epoch: 7, failedAttempts: 0, nextRetryAt: null, livenessError: null,
    residency: 'coldline', residencyState: 'resident', sizeBytes: 9.4 * 1024 ** 3,
    readMode: 'in_place', readModeDeclared: 'beside', readModeSource: 'graph',
    readModeWhy: [{ code: 'builds_off', text: SCHEMA.why.builds_off?.text ?? '', fix: null }],
}

/** What the graph's imports run under, and the properties they match by. */
export const IMPORT_SETTINGS: ImportSettings = {
    dataSourceId: 'ds_sales',
    overrides: { identifier: 'prop.sku', replaceMinLive: null, replaceDeleteFraction: 0.3, replaceCreateFraction: null, replaceMinMatchFraction: null },
    platform: { identifier: 'entity_id', replaceMinLive: 5000, replaceDeleteFraction: 0.5, replaceCreateFraction: 0.5, replaceMinMatchFraction: 0.05 },
    effective: {
        identifier: 'prop.sku', replaceMinLive: 5000, replaceDeleteFraction: 0.3, replaceCreateFraction: 0.5, replaceMinMatchFraction: 0.05,
        sources: { identifier: 'data_source', replaceMinLive: 'platform', replaceDeleteFraction: 'data_source', replaceCreateFraction: 'platform',
            replaceMinMatchFraction: 'platform' },
    },
    replaceGuard: false,
    followsParent: false,
    matchingProperties: [
        { name: 'sku', status: 'ready', seq: 214, current: true, createdAt: '2026-11-01T09:00:00Z' },
        { name: 'legacy_code', status: 'building', seq: 120, current: false, createdAt: '2026-11-16T16:00:00Z' },
    ],
    maxMatchingProperties: 10,
}

/** A fork's import settings: its root's default is a property, which a fork can't match by yet. */
export const FORK_IMPORT_SETTINGS: ImportSettings = {
    ...IMPORT_SETTINGS,
    dataSourceId: 'dsfork_7',
    effective: { ...IMPORT_SETTINGS.effective, identifier: 'entity_id', sources: { ...IMPORT_SETTINGS.effective.sources, identifier: 'fork' } },
    followsParent: true,
    matchingProperties: [],
}

/**
 * The full preview's impact at the workspace Finance: its four graphs, of which only Orders follows
 * the workspace's read mode (Payments and Sales lineage set their own, and the fork follows Sales
 * lineage). A workspace admin gets no node memory or residency figures.
 */
export function workspaceImpact(changes: PatchItem[]): Impact {
    const base = impact(changes)
    const reads = changes.find((c) => c.key === 'reads.mode' && 'value' in c)
    // Inheriting takes the platform's, Always the latest; switch when ready updates in place while builds are off.
    const to = reads ? reads.value ?? 'latest' : null
    const moves = to === 'latest'
    return {
        ...base,
        graphs: {
            inScope: WORKSPACE_GRAPHS.length,
            changed: moves ? 1 : 0,
            samples: moves ? [{ graphId: 'graph_orders', dataSourceId: 'ds_orders', workspaceId: WS, label: 'Orders',
                changes: [{ key: 'reads.mode', from: 'in_place', to: 'latest' }] }] : [],
        },
        alwaysLatest: reads ? { joining: moves ? 1 : 0, leaving: 0 } : null,
        memory: null,
        residency: null,
        drafts: base.drafts ? { workspaces: 1, removedAtNextSweep: 4 } : null,
        warnings: base.warnings.map((w) => (w.code === 'drafts_removed'
            ? { ...w, text: 'The next sweep removes the changes of 4 closed drafts in this workspace, and that can’t be undone.' } : w)),
    }
}
