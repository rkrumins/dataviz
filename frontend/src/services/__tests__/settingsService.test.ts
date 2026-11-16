/**
 * The settings API's shapes, held in one place: a place's values arrive as a list and are keyed;
 * a save sends the staged items and the reason (in the body and the activity header); a refusal
 * is read from FastAPI's `detail` by its `type`; history pages by cursor and is gathered into
 * change sets; signals and a graph's health are absent (null), not an error, while the server
 * can't answer them (404).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REASON_HEADER } from '../activityReason'
import { groupChangeSets, settingsError, settingsService, type HistoryEntry } from '../settingsService'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function answer(body: unknown, status = 200) {
    const fetch = vi.fn(async () => json(body, status))
    vi.stubGlobal('fetch', fetch)
    return fetch
}
const sentTo = (fetch: ReturnType<typeof answer>) => {
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    return { url: String(url), init, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers) }
}

afterEach(() => vi.unstubAllGlobals())

const resolved = (key: string, version = 1) => ({
    key, effective: 'latest', declared: null, source: 'default', status: 'in_effect', why: [], editable: true, editor: 'system_admin',
    allowed: ['latest', 'in_place'], version, trail: [{ scope: 'default', value: 'latest', env: null }],
})

describe('settingsService', () => {
    it('keys a place’s values, which arrive as a list', async () => {
        answer({ scope: 'graph', workspaceId: 'ws', graphId: 'g', dataSourceId: 'ds', editor: 'workspace_admin', version: 9, values: [resolved('reads.mode'), resolved('forks.maxPerGraph')] })
        const v = await settingsService.values({ scope: 'graph', workspaceId: 'ws', graphId: 'g' })
        expect(Object.keys(v.values)).toEqual(['reads.mode', 'forks.maxPerGraph'])
        expect(v).toMatchObject({ scope: 'graph', editor: 'workspace_admin', dataSourceId: 'ds', version: 9 })
    })

    it('saves the staged items with the reason, in the body and the activity header', async () => {
        const fetch = answer({ scope: 'platform', editor: 'system_admin', version: 10, values: [resolved('reads.mode', 2)], changeSetId: 'cs_1' })
        const res = await settingsService.save({ scope: 'platform' }, [
            { key: 'reads.mode', value: 'in_place', expectedVersion: 1 },
            { key: 'drafts.keepClosedDays', limits: { range: [1, 90] }, expectedVersion: 0 },
        ], 'Faster canvases')
        const sent = sentTo(fetch)
        expect(sent.url).toBe('/api/v1/admin/versioning/settings')
        expect(sent.init.method).toBe('PATCH')
        expect(sent.body).toEqual({
            changes: [{ key: 'reads.mode', value: 'in_place', expectedVersion: 1 }, { key: 'drafts.keepClosedDays', limits: { range: [1, 90] }, expectedVersion: 0 }],
            reason: 'Faster canvases',
        })
        expect(decodeURIComponent(sent.headers.get(REASON_HEADER) ?? '')).toBe('Faster canvases')
        expect(res.changeSetId).toBe('cs_1')
        expect(res.values['reads.mode'].version).toBe(2)
    })

    it('reads a refusal by its type: the values refused, who may set one, what changed meanwhile, a fork’s root', async () => {
        answer({ detail: { type: 'invalid_settings', message: 'No', errors: [{ key: 'reads.mode', code: 'not_allowed', message: 'Not offered' }] } }, 422)
        const invalid = await settingsService.save({ scope: 'platform' }, [{ key: 'reads.mode', value: 'beside', expectedVersion: 1 }], 'x').catch(settingsError)
        expect(invalid).toMatchObject({ status: 422, type: 'invalid_settings', errors: [{ key: 'reads.mode', message: 'Not offered' }] })

        answer({ detail: { type: 'setting_not_permitted', message: 'No', denied: [{ key: 'residency.class', code: 'editor', message: '', editor: 'system_admin' }] } }, 403)
        const denied = await settingsService.save({ scope: 'workspace', workspaceId: 'ws' }, [{ key: 'residency.class', value: 'always', expectedVersion: 0 }], 'x').catch(settingsError)
        expect(denied).toMatchObject({ status: 403, type: 'setting_not_permitted', denied: [{ key: 'residency.class', editor: 'system_admin' }] })

        answer({ detail: { type: 'settings_conflict', message: 'Changed', conflicts: [{ key: 'reads.mode', scope: 'platform', scopeId: '', expected: 1, actual: 2 }] } }, 409)
        const conflict = await settingsService.save({ scope: 'platform' }, [{ key: 'reads.mode', value: 'latest', expectedVersion: 1 }], 'x').catch(settingsError)
        expect(conflict).toMatchObject({ status: 409, type: 'settings_conflict', conflicts: [{ key: 'reads.mode', actual: 2 }] })

        answer({ detail: { type: 'follows_root', message: 'A fork', rootGraphId: 'g_root', rootDataSourceId: 'ds_root', workspaceId: 'ws' } }, 409)
        const fork = await settingsService.values({ scope: 'graph', workspaceId: 'ws', graphId: 'g_fork' }).catch(settingsError)
        expect(fork).toMatchObject({ type: 'follows_root', root: { graphId: 'g_root', dataSourceId: 'ds_root', workspaceId: 'ws' } })

        answer({ detail: { type: 'feature_disabled', feature: 'versioningEnabled', message: 'Version control is turned off' } }, 403)
        const off = await settingsService.preview({ scope: 'graph', workspaceId: 'ws', graphId: 'g' }, [{ key: 'reads.mode', value: 'latest', expectedVersion: 0 }], 'quick').catch(settingsError)
        expect(off).toMatchObject({ status: 403, type: 'feature_disabled', message: 'Version control is turned off' })
    })

    it('keys a preview’s values, and fills the impact’s missing parts with null', async () => {
        const fetch = answer({ scope: 'platform', mode: 'full', values: [{ ...resolved('reads.mode'), example: 'An example' }], impact: { graphs: { inScope: 3, changed: 1, samples: [] }, warnings: [] } })
        const p = await settingsService.preview({ scope: 'platform' }, [{ key: 'reads.mode', value: 'in_place', expectedVersion: 1 }], 'full')
        expect(sentTo(fetch).url).toBe('/api/v1/admin/versioning/settings/preview?mode=full')
        expect(p.values['reads.mode'].example).toBe('An example')
        expect(p.impact).toMatchObject({ graphs: { changed: 1 }, memory: null, residency: null, drafts: null, outsideLimits: null, unavailable: [] })
    })

    it('pages history by cursor, and gathers its entries into change sets', async () => {
        const fetch = answer({ scope: 'platform', entries: [], nextCursor: null })
        await settingsService.history({ scope: 'platform' }, { key: 'reads.mode', scope: 'graph' }, 41)
        expect(sentTo(fetch).url).toBe('/api/v1/admin/versioning/settings/history?key=reads.mode&scope=graph&cursor=41')

        const e = (id: number, changeSetId: string, key: string): HistoryEntry => ({
            id, changeSetId, key, at: '2026-11-16T10:00:00Z', actor: null, reason: null, source: 'api', scope: 'platform', scopeId: '',
            from: { value: null, limits: null }, to: { value: 1, limits: null }, version: 1,
        })
        expect(groupChangeSets([e(3, 'b', 'x'), e(2, 'b', 'y'), e(1, 'a', 'z')]).map((s) => [s.id, s.entries.map((x) => x.key)]))
            .toEqual([['b', ['x', 'y']], ['a', ['z']]])
    })

    it('treats signals and a graph’s health as absent while the server can’t report them', async () => {
        answer({ detail: 'Not Found' }, 404)
        await expect(settingsService.signals('24h')).resolves.toBeNull()
        answer({ detail: 'Not Found' }, 404)
        await expect(settingsService.health('ws', 'g')).resolves.toBeNull()
        answer({ asOf: '2026-11-16T10:00:00Z', versionsBehind: 0 })
        await expect(settingsService.health('ws', 'g')).resolves.toMatchObject({ versionsBehind: 0, head: null, memory: null, problems: [] })
    })
})
