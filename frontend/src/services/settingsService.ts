/**
 * settingsService — the versioned-graph settings API, and every assumption this app makes about
 * its shapes, in one file.
 *
 * Three places hold settings, and each answers the same five requests:
 *
 *   platform    /api/v1/admin/versioning/settings                       (system admins)
 *   workspace   /api/v1/{ws}/versioning/settings                        (workspace admins)
 *   graph       /api/v1/{ws}/versioning/graphs/{graphId}/settings       (a fork answers 409 follows_root)
 *
 *   GET          the values: each setting as the resolver answers it at that place
 *   PATCH        save: all or nothing, each value with the version it was decided on
 *   POST preview what a save would do (`quick` on each edit, `full` with the impact on Review)
 *   GET history  each change of a value, newest first, by cursor
 *   POST history/{changeSet}/revert   put a change back
 *
 * The rest: the registry with its guidance (`/settings/versioned-graphs/schema`, which the browser
 * revalidates against its ETag), the fleet inventory and its figures, a workspace's graphs with
 * what each sets itself (`/{ws}/versioning/settings/graphs`), each node's memory, the signals
 * counted over the last day, and one graph's health.
 *
 * The server's resolver dicts are the kit's `ResolvedSetting` as they are (`components/settings/
 * types.ts`); the one reshaping here is that a place's values arrive as a list and the kit keys
 * them (`ResolvedValues`). A refusal arrives as FastAPI's `{detail: {type, message, …}}` and is
 * turned into a `SettingsRequestError`. The workspace and graph routes sit behind the version-
 * control switch: while it is off, a save, a preview or a revert is refused (403
 * `feature_disabled`), and the page shows the place read-only, saying why.
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { authFetch } from './apiClient'
import { withReason } from './activityReason'
import { graphStoreService } from './graphStoreService'
import type { ResidencyState, VersionedGraphRow, VersionedGraphsFilter } from './systemStatusService'
import type { GraphUpdateProgress } from './versioningApiService'
import type {
    Audience, Editor, Limits, NodeMemory, ResolvedSetting, ResolvedValues, Scope, SettingsSchema, SettingValue, Status, TrailScope,
    WhyItem,
} from '@/components/settings/types'
import type { PatchItem } from '@/components/settings/useStagedChanges'

const API = '/api/v1'

// ── Where ───────────────────────────────────────────────────────────────────

/** Whose settings: the platform's, a workspace's or a graph's. */
export type SettingsPlace =
    | { scope: 'platform' }
    | { scope: 'workspace'; workspaceId: string }
    | { scope: 'graph'; workspaceId: string; graphId: string }

export const PLATFORM: SettingsPlace = { scope: 'platform' }

const enc = encodeURIComponent

function settingsPath(place: SettingsPlace): string {
    if (place.scope === 'platform') return `${API}/admin/versioning/settings`
    if (place.scope === 'workspace') return `${API}/${enc(place.workspaceId)}/versioning/settings`
    return `${API}/${enc(place.workspaceId)}/versioning/graphs/${enc(place.graphId)}/settings`
}

/** A stable cache key for a place. */
const placeKey = (place: SettingsPlace) =>
    place.scope === 'platform' ? ['platform'] : place.scope === 'workspace' ? ['workspace', place.workspaceId] : ['graph', place.workspaceId, place.graphId]

const byKey = <T extends { key: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.key, i]))

// ── Values ──────────────────────────────────────────────────────────────────

export interface SettingsValues {
    scope: Scope
    workspaceId?: string
    graphId?: string
    dataSourceId?: string
    /** The viewer's role here; null: they may only read. */
    editor: Editor | null
    values: ResolvedValues
    /** The highest revision among the values read: it moves whenever one is saved. */
    version: number
}

/** As served: the values a list, each a resolver dict (the platform's with its saved `limits`). */
interface WireValues extends Omit<SettingsValues, 'values'> {
    values: ResolvedSetting[]
}

const toValues = (w: WireValues): SettingsValues => ({ ...w, values: byKey(w.values) })

export interface SaveResult extends SettingsValues {
    /** The change set recorded; null when nothing changed. */
    changeSetId: string | null
}

// ── Refusals ────────────────────────────────────────────────────────────────

export interface SettingProblem {
    key: string
    code: string
    message: string
}
export interface SettingDenied extends SettingProblem {
    /** Who may set it. */
    editor: Editor | null
}
export interface SettingConflict {
    key: string
    scope: Scope
    scopeId: string
    expected: number
    actual: number
}

/**
 * A refused request. `type` is the server's: `invalid_settings` (422), `setting_not_permitted`
 * (403), `settings_conflict` (409), `follows_root` (409, a fork), `not_revertible` (409),
 * `feature_disabled` (403, version control is off), `not_found` (404).
 */
export class SettingsRequestError extends Error {
    readonly status: number | null
    readonly type: string | null
    readonly errors: SettingProblem[]
    readonly denied: SettingDenied[]
    readonly conflicts: SettingConflict[]
    /** A fork's root, from 409 `follows_root`. */
    readonly root: { graphId: string; dataSourceId: string | null; workspaceId: string | null } | null

    constructor(message: string, init: Partial<Pick<SettingsRequestError, 'status' | 'type' | 'errors' | 'denied' | 'conflicts' | 'root'>> = {}) {
        super(message)
        this.name = 'SettingsRequestError'
        this.status = init.status ?? null
        this.type = init.type ?? null
        this.errors = init.errors ?? []
        this.denied = init.denied ?? []
        this.conflicts = init.conflicts ?? []
        this.root = init.root ?? null
    }
}

interface WireRefusal {
    type?: string
    message?: string
    errors?: SettingProblem[]
    denied?: SettingDenied[]
    conflicts?: SettingConflict[]
    rootGraphId?: string
    rootDataSourceId?: string | null
    workspaceId?: string | null
}

/** Any failure of a settings request, as a `SettingsRequestError`. */
export function settingsError(err: unknown): SettingsRequestError {
    if (err instanceof SettingsRequestError) return err
    const e = err as Error & { status?: number; detail?: unknown }
    const d: WireRefusal = e?.detail && typeof e.detail === 'object' ? (e.detail as WireRefusal) : {}
    const type = d.type ?? (e?.status === 404 ? 'not_found' : null)
    return new SettingsRequestError(d.message ?? e?.message ?? 'The request failed.', {
        status: e?.status ?? null,
        type,
        errors: d.errors ?? [],
        denied: d.denied ?? [],
        conflicts: d.conflicts ?? [],
        root: type === 'follows_root' && d.rootGraphId
            ? { graphId: d.rootGraphId, dataSourceId: d.rootDataSourceId ?? null, workspaceId: d.workspaceId ?? null }
            : null,
    })
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
    try {
        return await authFetch<T>(url, init)
    } catch (err) {
        throw settingsError(err)
    }
}

const notFound = (err: unknown) => settingsError(err).status === 404

// ── Preview ─────────────────────────────────────────────────────────────────

export type PreviewMode = 'quick' | 'full'

export interface PreviewItem extends ResolvedSetting {
    /** The setting's worked example, with the values that would be in force. */
    example: string
}

/** A value before and after. */
export interface Move<T> {
    from: T
    to: T
}

/**
 * The full preview's impact. Every part is best effort: one the server couldn't work out is
 * null and named in `unavailable`; one the change can't affect is null too. A workspace admin gets
 * no node memory, residency or pool figures.
 */
export interface Impact {
    /** Graphs in reach whose behaviour changes, with up to ten. */
    graphs: {
        inScope: number
        changed: number
        samples: Array<{
            graphId: string
            dataSourceId: string | null
            workspaceId: string | null
            label: string | null
            changes: Array<{ key: string; from: SettingValue; to: SettingValue }>
        }>
    } | null
    /** Graphs whose readers move to Always the latest (read from the database while behind), and away. */
    alwaysLatest: { joining: number; leaving: number } | null
    /** The free memory a copy of the largest graph needs, against each node's. */
    memory: {
        largestGraphBytes: number
        neededBytes: Move<number>
        copied: boolean
        nodes: Array<{ name: string | null; usedBytes: number; maxBytes: number; freeBytes: number; fits: boolean }>
    } | null
    /** What the next memory check would unload, load and leave waiting. */
    residency: {
        switchOn: boolean
        unloads: number
        unloadedBytes: number
        loads: number
        waits: number
        nodes: Array<{
            name: string
            usedBytes: number
            maxBytes: number | null
            usedAfterBytes: number
            unloads: Array<{ label: string | null; bytes: number | null }>
            loads: Array<{ label: string | null; bytes: number | null }>
            waits: Array<{ label: string | null; bytes: number | null; shortfallBytes?: number | null }>
        }>
    } | null
    /** The most reads one process runs on the database at once. */
    database: {
        readTimeoutMs?: Move<SettingValue>
        readsPerGraph?: Move<SettingValue>
        readsPerProcess?: Move<SettingValue>
        poolSize?: number | null
    } | null
    /** Closed drafts whose changes the next sweep would remove. */
    drafts: { workspaces: number; removedAtNextSweep: number } | null
    /** Values chosen below the platform that new limits leave outside them. */
    outsideLimits: {
        count: number
        locked: number
        samples: Array<{ key: string; scope: Scope; scopeId: string; value: SettingValue; status: 'exception' | 'locked' }>
    } | null
    /** What to acknowledge before saving. */
    warnings: Array<{ code: string; text: string; key?: string }>
    /** Parts that couldn't be worked out. */
    unavailable: string[]
}

export interface PreviewResult {
    mode: PreviewMode
    /** Each changed setting, and each other whose answer would change, by key. */
    values: Record<string, PreviewItem>
    impact: Impact | null
}

interface WirePreview {
    mode: PreviewMode
    values: Array<ResolvedSetting & { example?: string }>
    impact?: Partial<Impact> | null
}

function toImpact(w: Partial<Impact> | null | undefined): Impact | null {
    if (!w) return null
    return {
        graphs: w.graphs ?? null,
        alwaysLatest: w.alwaysLatest ?? null,
        memory: w.memory ?? null,
        residency: w.residency ?? null,
        database: w.database ?? null,
        drafts: w.drafts ?? null,
        outsideLimits: w.outsideLimits ?? null,
        warnings: w.warnings ?? [],
        unavailable: w.unavailable ?? [],
    }
}

// ── History ─────────────────────────────────────────────────────────────────

export type ChangeSource = 'api' | 'legacy_api' | 'migration' | 'revert'

/** One value's change. A save records one per value it changed, under one change set. */
export interface HistoryEntry {
    id: number
    changeSetId: string
    at: string
    actor: { id: string; name: string | null } | null
    reason: string | null
    source: ChangeSource
    key: string
    scope: Scope
    /** '' for the platform, a workspace's id, or a graph's data source id. */
    scopeId: string
    from: { value: SettingValue | null; limits: Limits | null }
    to: { value: SettingValue | null; limits: Limits | null }
    version: number
}

export interface HistoryFilter {
    key?: string
    actor?: string
    /** ISO instants. */
    since?: string
    until?: string
    scope?: Scope
}

export interface HistoryPage {
    entries: HistoryEntry[]
    /** The next page's cursor; null: no more. */
    nextCursor: number | null
}

/** A save: its values' changes, who made it, when and why. */
export interface ChangeSet {
    id: string
    at: string
    actor: HistoryEntry['actor']
    reason: string | null
    source: ChangeSource
    scope: Scope
    scopeId: string
    entries: HistoryEntry[]
}

/** Entries (newest first, as served) gathered into their change sets, in the same order. */
export function groupChangeSets(entries: HistoryEntry[]): ChangeSet[] {
    const sets = new Map<string, ChangeSet>()
    for (const e of entries) {
        const set = sets.get(e.changeSetId)
        if (set) set.entries.push(e)
        else sets.set(e.changeSetId, { id: e.changeSetId, at: e.at, actor: e.actor, reason: e.reason, source: e.source, scope: e.scope, scopeId: e.scopeId, entries: [e] })
    }
    return [...sets.values()]
}

// ── The fleet ───────────────────────────────────────────────────────────────

/** The inventory's filters: the Infrastructure ones, plus the read mode in force, the class and own settings. */
export interface GraphInventoryFilter extends VersionedGraphsFilter {
    readModeEffective?: 'latest' | 'in_place' | 'beside'
    residency?: 'always' | 'standard' | 'coldline'
    ownSettings?: boolean
}

export interface GraphInventoryPage {
    graphs: VersionedGraphRow[]
    nextCursor: string | null
}

/** One setting at a graph, in brief: the value in force, the one chosen, where it came from, and why they differ. */
export interface BriefSetting {
    effective: SettingValue
    declared: SettingValue | null
    source: TrailScope | 'env'
    status: Status
    why: WhyItem[]
}

/** One of a workspace's versioned graphs, as its page lists them. */
export interface WorkspaceGraph {
    graphId: string
    dataSourceId: string | null
    /** Its data source's name; null when it has none. */
    label: string | null
    /** A fork's root: the graph whose settings it follows. */
    follows: { graphId: string; dataSourceId: string | null } | null
    /** The keys of the settings it chose itself (a fork: none). */
    ownSettings: string[]
    readMode: BriefSetting
    residencyClass: BriefSetting
}

export interface WorkspaceGraphsPage {
    graphs: WorkspaceGraph[]
    nextCursor: string | null
}

/** The fleet's figures, over every live graph but forks. The five memory states add up to `graphs`. */
export interface GraphsSummary {
    graphs: number
    inMemory: number
    unloaded: number
    loading: number
    waitingForRoom: number
    /** No copy in the graph store yet. */
    noCopy: number
    building: number
    failing: number
    withOwnSettings: number
}

// ── Signals, health and profiles (later additions; each may be absent) ─────

/** A signal the registry names: what happened, and the settings it bears on. */
export interface SignalDefinition {
    id: string
    label: string
    symptom: string
    settings: string[]
    unit: string
    warnAt: number | null
}

/** How often each signal happened, platform-wide. */
export interface SignalCounts {
    asOf: string
    window: string
    /** The server couldn't count them (Redis out of reach): no counts, never zeros. */
    unavailable: boolean
    signals: Array<{
        id: string
        count: number
        byHour?: number[]
        topGraphs?: Array<{ graphId: string; dataSourceId: string | null; name: string | null; count: number }>
    }>
}

/** What the finder takes: a count over a window. */
export interface SignalCount {
    id: string
    count: number
    window: string
}

/** A starting point: a few values that go together. Applying one stages them; it never saves. */
export interface SettingsProfile {
    id: string
    title: string
    promise: string
    audience: Audience
    when: string[]
    values: Record<string, SettingValue>
    scopes: Scope[]
    caution: string
}

/** The registry as served: what this app knows of it, and what later releases add. */
export type ServedSchema = SettingsSchema & {
    profiles?: SettingsProfile[]
    signals?: SignalDefinition[]
}

/** A published version of a graph: its commit, when, by whom, and its message. */
export interface Revision {
    commitId: string
    at: string | null
    actor: { id: string; name: string | null } | null
    message: string | null
}

/**
 * What is known of a graph's new-version builds: the one in flight (`running`, or `waiting` for
 * room, a lock or a summaries job), else the last while the copy it left is kept (`switched`, or
 * `not_switched`: given up without a switch), else `none` (no switch within `windowSecs`).
 */
export interface LastBuild {
    outcome: 'running' | 'waiting' | 'switched' | 'not_switched' | 'none'
    /** In flight: when it was asked for. */
    since: string | null
    /** Finished: when it switched, or was given up; null when not known. */
    at: string | null
    waitingFor: 'room' | 'lock' | 'summaries' | null
    /** Why it waits, or the error its last attempt failed with: the server's words. */
    why: string | null
    /** In flight: attempts that failed so far. */
    attempts: number | null
    /** Finished: from when the copy it left (the previous one after a switch) is removed. */
    copyRemovedAfter: string | null
    /** `none`: how far back a switch would still show (the retire grace in force). */
    windowSecs: number | null
}

/**
 * A graph's health right now: each part best effort (null, with a problem saying why). A version
 * is known by its `seq` ("version #42"); its `version` is the revision behind it, null when that
 * couldn't be read. A fork's serving, memory and builds are its root's, which `follows` names.
 */
export interface GraphHealth {
    asOf: string
    head: { seq: number; version: Revision | null } | null
    serving: { seq: number; version: Revision | null; source: 'graph_store' | 'database' | null } | null
    versionsBehind: number | null
    readMode: { effective: string; declared: string | null; source: string; why: WhyItem[] } | null
    /** How far an update in flight is, as served: null while none is (absent from a server that doesn't publish it). */
    progress?: GraphUpdateProgress | null
    lastUpdate: { finishedAt: string | null; durationSecs: number | null; rows: number | null; ratePerSec: number | null } | null
    /** Its copy; `state` as the inventory has it (null: no copy in the graph store yet). */
    memory: {
        bytes: number | null; node: string | null; loaded: boolean | null; state: ResidencyState | null
        rehydratingSince: string | null; class: string | null; lastReadAt: string | null
    } | null
    lastBuild: LastBuild | null
    signals: Array<{ id: string; count24h: number }> | null
    /** A fork: the graph whose copy it reads through, named. */
    follows: { graphId: string; dataSourceId: string | null; label: string | null } | null
    problems: Array<{ part: string; message: string }>
}

// ── Requests ────────────────────────────────────────────────────────────────

export const settingsService = {
    schema: (): Promise<ServedSchema> => call<ServedSchema>(`${API}/settings/versioned-graphs/schema`),

    values: async (place: SettingsPlace): Promise<SettingsValues> => toValues(await call<WireValues>(settingsPath(place))),

    /** `items` carry `value` and/or `limits`; a field left out stays as it is. */
    save: async (place: SettingsPlace, items: PatchItem[], reason: string): Promise<SaveResult> => {
        const w = await call<WireValues & { changeSetId: string | null }>(settingsPath(place), withReason({
            method: 'PATCH',
            body: JSON.stringify({ changes: items, reason }),
        }, reason))
        return { ...toValues(w), changeSetId: w.changeSetId ?? null }
    },

    preview: async (place: SettingsPlace, items: PatchItem[], mode: PreviewMode, signal?: AbortSignal): Promise<PreviewResult> => {
        const w = await call<WirePreview>(`${settingsPath(place)}/preview?mode=${mode}`, {
            method: 'POST',
            body: JSON.stringify({ changes: items }),
            signal,
        })
        return {
            mode: w.mode ?? mode,
            values: byKey((w.values ?? []).map((i) => ({ ...i, example: i.example ?? '' }))),
            impact: toImpact(w.impact),
        }
    },

    history: (place: SettingsPlace, filter: HistoryFilter, cursor?: number | null): Promise<HistoryPage> => {
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(filter)) if (v) params.set(k, String(v))
        if (cursor) params.set('cursor', String(cursor))
        return call<HistoryPage>(`${settingsPath(place)}/history?${params}`)
    },

    revert: async (place: SettingsPlace, changeSetId: string, reason: string): Promise<SaveResult> => {
        const w = await call<WireValues & { changeSetId: string | null }>(
            `${settingsPath(place)}/history/${enc(changeSetId)}/revert`,
            withReason({ method: 'POST', body: JSON.stringify({ reason }) }, reason),
        )
        return { ...toValues(w), changeSetId: w.changeSetId ?? null }
    },

    /** One page of the fleet inventory; pass the previous page's `nextCursor`. */
    graphs: (filter: GraphInventoryFilter, cursor?: string | null): Promise<GraphInventoryPage> => {
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params.set(k, String(v))
        if (cursor) params.set('cursor', cursor)
        return call<GraphInventoryPage>(`${API}/admin/versioning/graphs?${params}`)
    },

    summary: (): Promise<GraphsSummary> => call<GraphsSummary>(`${API}/admin/versioning/graphs/summary`),

    /** One page of a workspace's graphs, by graph id; pass the previous page's `nextCursor`. */
    workspaceGraphs: (workspaceId: string, cursor?: string | null): Promise<WorkspaceGraphsPage> =>
        call<WorkspaceGraphsPage>(`${API}/${enc(workspaceId)}/versioning/settings/graphs${cursor ? `?cursor=${enc(cursor)}` : ''}`),

    /**
     * Each graph store node's memory, as the Graph store page last read it (its cached topology:
     * nothing is planned or swept to answer). What the memory gauges and the explainers draw; a
     * master whose memory couldn't be read, or that has no limit, is left out.
     */
    nodeMemory: async (): Promise<NodeMemory[]> => {
        const t = await graphStoreService.getTopology()
        return t.instances.flatMap((i) => i.shards.flatMap(({ master: m }) => (m.memory.used != null && m.memory.maxmemory
            ? [{ id: m.endpoint, label: m.endpoint, usedBytes: m.memory.used, maxBytes: m.memory.maxmemory }] : [])))
    },

    /** Null when the server doesn't count signals yet (404). */
    signals: async (window: '1h' | '24h' | '7d'): Promise<SignalCounts | null> => {
        try {
            return await call<SignalCounts>(`${API}/admin/versioning/signals?window=${window}`)
        } catch (err) {
            if (notFound(err)) return null
            throw err
        }
    },

    /** Null when the server can't report a graph's health yet (404). */
    health: async (workspaceId: string, graphId: string): Promise<GraphHealth | null> => {
        try {
            const w = await call<Partial<GraphHealth> & { asOf: string }>(`${API}/${enc(workspaceId)}/versioning/graphs/${enc(graphId)}/health`)
            return {
                asOf: w.asOf,
                head: w.head ?? null,
                serving: w.serving ?? null,
                versionsBehind: w.versionsBehind ?? null,
                readMode: w.readMode ?? null,
                progress: w.progress ?? null,
                lastUpdate: w.lastUpdate ?? null,
                memory: w.memory ?? null,
                lastBuild: w.lastBuild ?? null,
                signals: w.signals ?? null,
                follows: w.follows ?? null,
                problems: w.problems ?? [],
            }
        } catch (err) {
            if (notFound(err)) return null
            throw err
        }
    },
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/** Refreshing while nothing is staged: modest, and paused while the tab is hidden (react-query's default). */
const REFRESH_MS = 30_000

export const settingsKeys = {
    all: ['versioned-graph-settings'] as const,
    schema: () => [...settingsKeys.all, 'schema'] as const,
    values: (place: SettingsPlace) => [...settingsKeys.all, 'values', ...placeKey(place)] as const,
    preview: (place: SettingsPlace, mode: PreviewMode, body: string) => [...settingsKeys.all, 'preview', mode, ...placeKey(place), body] as const,
    history: (place: SettingsPlace, filter: HistoryFilter) => [...settingsKeys.all, 'history', ...placeKey(place), filter] as const,
    graphs: (filter: GraphInventoryFilter) => [...settingsKeys.all, 'graphs', filter] as const,
    workspaceGraphs: (workspaceId: string) => [...settingsKeys.all, 'workspace-graphs', workspaceId] as const,
    summary: () => [...settingsKeys.all, 'summary'] as const,
    nodes: () => [...settingsKeys.all, 'nodes'] as const,
    signals: () => [...settingsKeys.all, 'signals', '24h'] as const,
    health: (workspaceId: string, graphId: string) => [...settingsKeys.all, 'health', workspaceId, graphId] as const,
}

/** The registry. The browser revalidates it against its ETag; the app keeps it for the session. */
export function useSettingsSchema() {
    return useQuery({ queryKey: settingsKeys.schema(), queryFn: settingsService.schema, staleTime: 10 * 60_000, retry: 1 })
}

/**
 * A place's values. Refreshed every 30 s, but never while something is staged (`staged()`): the
 * page shows what the person decided against, and Save checks the versions they saw.
 */
export function useSettingsValues(place: SettingsPlace, { staged = () => false, enabled = true }: { staged?: () => boolean; enabled?: boolean } = {}) {
    return useQuery({
        queryKey: settingsKeys.values(place),
        queryFn: () => settingsService.values(place),
        enabled,
        refetchInterval: () => (staged() ? false : REFRESH_MS),
        refetchOnWindowFocus: () => !staged(),
        retry: (count, err) => count < 1 && !['follows_root', 'not_found'].includes(settingsError(err).type ?? ''),
    })
}

/**
 * What saving `items` would do. The caller debounces `items` (quick) or asks once (full, on
 * Review); a new body cancels the request for the last one, which no longer has an observer.
 */
export function useSettingsPreview(place: SettingsPlace, items: PatchItem[], mode: PreviewMode, { enabled = true }: { enabled?: boolean } = {}) {
    const body = JSON.stringify(items)
    return useQuery({
        queryKey: settingsKeys.preview(place, mode, body),
        queryFn: ({ signal }) => settingsService.preview(place, items, mode, signal),
        enabled: enabled && items.length > 0,
        placeholderData: mode === 'quick' ? keepPreviousData : undefined,
        staleTime: 30_000,
        retry: false,
    })
}

/** What a save or a revert can change besides the values: the history, the registry's sentences,
 *  and the fleet as the inventory, its figures and a graph's health say it. */
function invalidateAfterSave(qc: ReturnType<typeof useQueryClient>) {
    for (const part of ['history', 'graphs', 'summary', 'health', 'workspace-graphs'] as const) void qc.invalidateQueries({ queryKey: [...settingsKeys.all, part] })
    void qc.invalidateQueries({ queryKey: settingsKeys.schema() })
}

export function useSaveSettings(place: SettingsPlace) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ items, reason }: { items: PatchItem[]; reason: string }) => settingsService.save(place, items, reason),
        onSuccess: (res) => {
            qc.setQueryData(settingsKeys.values(place), res)
            invalidateAfterSave(qc)
        },
    })
}

export function useRevertChangeSet(place: SettingsPlace) {
    const qc = useQueryClient()
    return useMutation({
        mutationFn: ({ changeSetId, reason }: { changeSetId: string; reason: string }) => settingsService.revert(place, changeSetId, reason),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: [...settingsKeys.all, 'values'] })
            invalidateAfterSave(qc)
        },
    })
}

export function useSettingsHistory(place: SettingsPlace, filter: HistoryFilter) {
    return useInfiniteQuery({
        queryKey: settingsKeys.history(place, filter),
        queryFn: ({ pageParam }) => settingsService.history(place, filter, pageParam),
        initialPageParam: null as number | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        retry: 1,
    })
}

export function useGraphInventory(filter: GraphInventoryFilter) {
    return useInfiniteQuery({
        queryKey: settingsKeys.graphs(filter),
        queryFn: ({ pageParam }) => settingsService.graphs(filter, pageParam),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        retry: 1,
        refetchOnWindowFocus: false,
    })
}

/** A workspace's graphs, a page at a time (by graph id). */
export function useWorkspaceGraphs(workspaceId: string) {
    return useInfiniteQuery({
        queryKey: settingsKeys.workspaceGraphs(workspaceId),
        queryFn: ({ pageParam }) => settingsService.workspaceGraphs(workspaceId, pageParam),
        initialPageParam: null as string | null,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        retry: 1,
        refetchOnWindowFocus: false,
    })
}

export function useGraphsSummary() {
    return useQuery({ queryKey: settingsKeys.summary(), queryFn: settingsService.summary, refetchInterval: REFRESH_MS, retry: 1 })
}

/** Each node's memory, for the gauges; a failure leaves them out (the explainers then draw nothing). */
export function useNodeMemory(enabled: boolean) {
    return useQuery({ queryKey: settingsKeys.nodes(), queryFn: settingsService.nodeMemory, enabled, refetchInterval: REFRESH_MS, retry: false })
}

/** Signals over the last day: asked for only where the registry names signals (`enabled`). */
export function useSignals(enabled: boolean) {
    return useQuery({
        queryKey: settingsKeys.signals(),
        queryFn: () => settingsService.signals('24h'),
        enabled,
        refetchInterval: 60_000,
        retry: false,
    })
}

/** As the finder takes them. None when the server couldn't count them: an empty list would read as "nothing happened". */
export function signalCounts(counts: SignalCounts | null | undefined): SignalCount[] | undefined {
    return counts && !counts.unavailable ? counts.signals.map((s) => ({ id: s.id, count: s.count, window: counts.window })) : undefined
}

export function useGraphHealth(workspaceId: string, graphId: string, enabled: boolean) {
    return useQuery({
        queryKey: settingsKeys.health(workspaceId, graphId),
        queryFn: () => settingsService.health(workspaceId, graphId),
        enabled,
        refetchInterval: REFRESH_MS,
        retry: false,
    })
}
