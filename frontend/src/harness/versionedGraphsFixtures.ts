/**
 * The versioned-graphs harness's server: every route Admin → Versioned graphs, a workspace's
 * Versioned graphs tab and a data source's Versioning tab read or write, answered from the section's
 * API fixtures (`AdminVersionedGraphs/__fixtures__/api.ts`), by scenario. A save is applied to the
 * fixture's values, so a review, a save and its Undo play out as they would against the real API.
 *
 *   ok               everything answers, for a system admin
 *   loading          the settings, figures and lists never answer
 *   error            the settings, figures, lists and history fail
 *   empty            no graphs and no history yet
 *   readonly         the settings for a viewer who may only read them
 *   workspace-admin  a workspace's and a graph's settings for the workspace's admin
 *   fork             the graph is a fork (409 follows_root): its health names the root it follows
 *   conflict         every save is refused: someone changed a value meanwhile
 *
 * As production would answer: the inventory and the history filter on the server and page by
 * cursor, nothing is built beside while New-version builds are off (the harness has them off), a
 * graph's review counts the one graph, and the directory finds people for "Who".
 */
import {
    BRANCHES, COMMITS, FEATURES, FORK_HEALTH, FORK_IMPORT_SETTINGS, FORKS, GRAPHS, HEALTH, HISTORY, IMPORT_SETTINGS,
    OPERATOR_SCHEMA, PROVIDERS, RESOLVED, SCHEMA, SUMMARY, TOPOLOGY, WATERMARK, WORKSPACE_GRAPHS, WORKSPACE_HISTORY,
    WS, GRAPH, ROOT,
    graphImpact, graphValues, platformValues, preview, workspaceImpact, workspaceValues,
} from '../components/admin/AdminVersionedGraphs/__fixtures__/api'
import type { ResolvedSetting, TrailScope } from '../components/settings/types'
import type { PatchItem } from '../components/settings/useStagedChanges'
import type { HistoryEntry } from '../services/settingsService'
import type { VersionedGraphRow } from '../services/systemStatusService'

export type Scenario = 'ok' | 'loading' | 'error' | 'empty' | 'readonly' | 'workspace-admin' | 'fork' | 'conflict'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const never = () => new Promise<Response>(() => {})
const failed = (message: string, status = 503) => json({ detail: message }, status)
const ORDER: TrailScope[] = ['default', 'platform', 'workspace', 'graph']

/** A workspace's values with `changes` saved there: a value null inherits from the nearest level above with one. */
function savedAtWorkspace<T extends { values: ResolvedSetting[]; version: number }>(place: T, changes: PatchItem[]): T {
    return {
        ...place,
        values: place.values.map((r) => {
            const c = changes.find((x) => x.key === r.key)
            if (!c || !('value' in c)) return r
            const trail = r.trail.map((t) => (t.scope === 'workspace' ? { ...t, value: c.value ?? null } : t))
            const above = trail.filter((t) => ORDER.indexOf(t.scope) < ORDER.indexOf('workspace') && t.value !== null).at(-1) ?? r.trail[0]
            const v = c.value ?? above.value ?? r.effective
            return { ...r, trail, effective: v, declared: v, source: c.value !== null && c.value !== undefined ? 'workspace' : above.scope, version: r.version + 1 }
        }),
        version: place.version + 1,
    }
}

const conflict = (key: string, scope: string, scopeId: string) => json({ detail: {
    type: 'settings_conflict', message: 'Changed since it was read', conflicts: [{ key, scope, scopeId, expected: 1, actual: 2 }],
} }, 409)

/** The inventory with New-version builds off, as the harness has them: nothing is built beside, and switch when ready updates in place. */
const LISTED: VersionedGraphRow[] = GRAPHS.map((g) => (g.build || g.readModeEffective === 'beside'
    ? { ...g, build: null, readModeEffective: g.readMode === 'beside' ? 'in_place' : g.readMode ?? 'latest' } : g))
/** Data sources whose graphs chose settings of their own. */
const OWN = new Set(WORKSPACE_GRAPHS.filter((g) => g.ownSettings.length).map((g) => g.dataSourceId))
const PAGE = 6

/** The inventory's filters, as the server applies them, a page of what is left after `cursor`, and how many they keep. */
function inventory(q: URLSearchParams): { graphs: VersionedGraphRow[]; nextCursor: string | null; total: number } {
    const want = (k: string) => q.get(k) ?? ''
    const text = want('q').toLowerCase()
    const found = LISTED.filter((g) => {
        const kind = g.orphan ? 'orphan' : g.forkParentGraphId ? 'fork' : 'main'
        return (!want('provider') || g.falkorProvider === want('provider'))
            && (!want('status') || g.status === want('status') || g.residencyState === want('status') || (want('status') === 'failed' && Boolean(g.lastError)))
            && (!want('kind') || kind === want('kind'))
            && (!want('readModeEffective') || g.readModeEffective === want('readModeEffective'))
            && (!want('residency') || g.residency === want('residency'))
            && (!want('ownSettings') || (want('ownSettings') === 'true') === OWN.has(g.dataSourceId))
            && (!text || [g.dataSourceLabel, g.falkorGraphName, g.graphId, g.workspaceName].some((v) => v?.toLowerCase().includes(text)))
    })
    const from = q.get('cursor') ? found.findIndex((g) => g.graphId === q.get('cursor')) + 1 : 0
    const page = found.slice(from, from + PAGE)
    return { graphs: page, nextCursor: from + PAGE < found.length ? page.at(-1)!.graphId : null, total: found.length }
}

/** The history's filters, as the server applies them. */
function history(entries: HistoryEntry[], q: URLSearchParams): HistoryEntry[] {
    const since = q.get('since')
    const until = q.get('until')
    return entries.filter((e) => (!q.get('key') || e.key === q.get('key')) && (!q.get('actor') || e.actor?.id === q.get('actor'))
        && (!q.get('scope') || e.scope === q.get('scope')) && (!since || e.at >= since) && (!until || e.at <= until))
}

/** The directory, for "Who": the people the history names, and one who changed nothing. */
const PEOPLE = [
    { id: 'usr_ada', displayName: 'Ada Lovelace', email: 'ada@example.com' },
    { id: 'usr_grace', displayName: 'Grace Hopper', email: 'grace@example.com' },
    { id: 'usr_alice', displayName: 'Alice Martin', email: 'alice@example.com' },
    { id: 'usr_katherine', displayName: 'Katherine Johnson', email: 'katherine@example.com' },
]

export function versionedGraphsFetch(scenario: Scenario): typeof fetch {
    let platform = platformValues(scenario === 'readonly' ? null : 'system_admin')
    let workspace = workspaceValues(scenario === 'readonly' ? null : scenario === 'workspace-admin' ? 'workspace_admin' : 'system_admin')
    let saves = 0

    const save = (changes: PatchItem[]) => {
        saves += 1
        platform = {
            ...platform,
            values: platform.values.map((r) => {
                const c = changes.find((x) => x.key === r.key)
                if (!c) return r
                const trail = r.trail.map((t) => (t.scope === 'platform'
                    ? { ...t, ...('value' in c ? { value: c.value ?? null } : {}), ...('limits' in c ? { limits: c.limits ?? null } : {}) } : t))
                const v = 'value' in c ? c.value ?? r.trail[0].value : r.effective
                return { ...r, trail, effective: v ?? r.effective, declared: v, source: 'value' in c && c.value !== null ? 'platform' : r.source,
                    ...('limits' in c ? { limits: c.limits ?? null } : {}), version: r.version + 1 }
            }),
            version: platform.version + 1,
        }
        return { ...platform, changeSetId: `cs_harness_${saves}` }
    }

    return async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
        const p = url.pathname
        const method = (init?.method ?? 'GET').toUpperCase()
        const body = init?.body ? JSON.parse(String(init.body)) as { changes?: PatchItem[] } : {}

        // The deployment's values are a system administrator's to see.
        if (p.endsWith('/settings/versioned-graphs/schema')) return json(scenario === 'readonly' || scenario === 'workspace-admin' ? SCHEMA : OPERATOR_SCHEMA)
        if (p.endsWith('/admin/features')) return json(FEATURES)
        if (p.endsWith('/admin/system/status')) return json({ status: 'healthy', graphProviders: PROVIDERS, services: [] })
        if (p.endsWith('/admin/graph-store/topology')) return json(TOPOLOGY)
        if (p.endsWith('/admin/versioning/signals')) return json({ detail: 'Not Found' }, 404)
        if (p.endsWith('/api/v1/directory')) {
            const term = (url.searchParams.get('q') ?? '').toLowerCase()
            return json({ users: PEOPLE.filter((u) => `${u.displayName} ${u.email}`.toLowerCase().includes(term)), groups: [] })
        }
        if (p.endsWith('/api/v1/directory/people')) {
            const ids = (url.searchParams.get('ids') ?? '').split(',')
            return json(PEOPLE.filter((u) => ids.includes(u.id)).map((u) => ({ ...u, deleted: false })))
        }

        if (p.endsWith('/admin/versioning/graphs/summary')) {
            if (scenario === 'loading') return never()
            if (scenario === 'error') return failed('The graph store didn’t answer in time')
            // Nothing is built beside while New-version builds are off.
            return json(scenario === 'empty'
                ? { graphs: 0, inMemory: 0, unloaded: 0, loading: 0, waitingForRoom: 0, noCopy: 0, building: 0, failing: 0, withOwnSettings: 0, largestGraph: null }
                : { ...SUMMARY, building: 0 })
        }
        if (p.endsWith('/admin/versioning/graphs')) {
            if (scenario === 'loading') return never()
            if (scenario === 'error') return failed('The graph store didn’t answer in time')
            return json(scenario === 'empty' ? { graphs: [], nextCursor: null, total: 0 } : inventory(url.searchParams))
        }

        if (p.endsWith('/admin/versioning/settings/preview')) return json(preview(body.changes ?? [], url.searchParams.get('mode') === 'full' ? 'full' : 'quick'))
        if (p.endsWith('/admin/versioning/settings/history')) {
            if (scenario === 'error') return failed('The settings store couldn’t be read', 500)
            return json({ scope: 'platform', entries: scenario === 'empty' ? [] : history(HISTORY, url.searchParams), nextCursor: null })
        }
        if (/\/admin\/versioning\/settings\/history\/[^/]+\/revert$/.test(p)) return json({ ...platform, changeSetId: 'cs_revert' })
        if (p.endsWith('/admin/versioning/settings')) {
            if (method === 'PATCH') {
                if (scenario === 'conflict') return conflict(body.changes?.[0]?.key ?? 'reads.mode', 'platform', '')
                return json(save(body.changes ?? []))
            }
            if (scenario === 'loading') return never()
            if (scenario === 'error') return failed('The settings store couldn’t be read', 500)
            if (scenario === 'empty') return json({ ...platform, values: [] })
            return json(platform)
        }

        // A workspace's settings, its graphs and its history (`admin` is the platform's, above).
        const ws = p.match(/\/api\/v1\/(?!admin\/)[^/]+\/versioning\/settings(\/preview|\/graphs|\/history(?:\/[^/]+\/revert)?)?$/)
        if (ws) {
            const rest = ws[1] ?? ''
            if (rest === '/graphs') {
                if (scenario === 'loading') return never()
                if (scenario === 'error') return failed('The graph store didn’t answer in time')
                return json({ scope: 'workspace', workspaceId: WS, graphs: scenario === 'empty' ? [] : WORKSPACE_GRAPHS, nextCursor: null })
            }
            if (rest === '/preview') {
                const base = Object.fromEntries(workspace.values.map((r) => [r.key, r]))
                const full = url.searchParams.get('mode') === 'full'
                return json({ ...preview(body.changes ?? [], full ? 'full' : 'quick', base, 'workspace'), scope: 'workspace',
                    ...(full ? { impact: workspaceImpact(body.changes ?? []) } : {}) })
            }
            if (rest.endsWith('/revert')) return json({ ...workspace, changeSetId: 'cs_revert' })
            if (rest === '/history') {
                if (scenario === 'error') return failed('The settings store couldn’t be read', 500)
                return json({ scope: 'workspace', entries: scenario === 'empty' ? [] : history(WORKSPACE_HISTORY, url.searchParams), nextCursor: null })
            }
            if (method === 'PATCH') {
                if (scenario === 'conflict') return conflict(body.changes?.[0]?.key ?? 'reads.mode', 'workspace', WS)
                saves += 1
                workspace = savedAtWorkspace(workspace, body.changes ?? [])
                return json({ ...workspace, changeSetId: `cs_harness_${saves}` })
            }
            if (scenario === 'loading') return never()
            if (scenario === 'error') return failed('The settings store couldn’t be read', 500)
            return json(workspace)
        }

        const graph = p.match(/\/api\/v1\/([^/]+)\/versioning\/graphs\/([^/]+)\/(settings|health)(\/preview)?$/)
        if (graph) {
            const [, , gid, what, previewing] = graph
            if (what === 'health') return json(scenario === 'fork' && gid === GRAPH ? FORK_HEALTH : HEALTH)
            if (previewing) {
                // A graph's own change reaches the one graph.
                const full = url.searchParams.get('mode') === 'full'
                const base = Object.fromEntries(graphValues().values.map((r) => [r.key, r]))
                return json({ ...preview(body.changes ?? [], full ? 'full' : 'quick', undefined, 'graph'), scope: 'graph',
                    ...(full ? { impact: graphImpact(body.changes ?? [], base) } : {}) })
            }
            if (scenario === 'fork' && gid === GRAPH) {
                return json({ detail: { type: 'follows_root', message: 'A fork follows its root graph’s settings', rootGraphId: ROOT, rootDataSourceId: 'ds_root', workspaceId: WS } }, 409)
            }
            if (method === 'PATCH') return json({ ...graphValues('workspace_admin'), changeSetId: 'cs_graph' })
            if (scenario === 'loading') return never()
            if (scenario === 'error') return failed('The settings store couldn’t be read', 500)
            return json(graphValues(scenario === 'workspace-admin' ? 'workspace_admin' : 'system_admin'))
        }

        // What a data source's Versioning tab reads besides the settings.
        const vers = p.match(/\/api\/v1\/(?!admin\/)[^/]+\/versioning\/(resolve|graphs\/[^/]+\/(branches|commits|forks|watermark|import-settings)|data-sources\/[^/]+\/pull-requests)$/)
        if (vers) {
            const [, route, what] = vers
            if (route === 'resolve') return json(RESOLVED)
            if (route.startsWith('data-sources/')) return json([])
            if (what === 'branches') return json(url.searchParams.getAll('status').length ? [] : BRANCHES)
            if (what === 'commits') return json(COMMITS)
            if (what === 'forks') return json(scenario === 'fork' ? [] : FORKS)
            if (what === 'watermark') return json(WATERMARK)
            return json(scenario === 'fork' ? FORK_IMPORT_SETTINGS : IMPORT_SETTINGS)
        }
        return json({ detail: `not in the versioned-graphs harness: ${method} ${p}` }, 404)
    }
}

export { WS, GRAPH }
