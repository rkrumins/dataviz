import { describe, expect, it } from 'vitest'
import type { WorkspaceResponse } from '@/services/workspaceService'
import { healthOf, readableSources, recentDataChanges, summarizeDataHealth, type RatedSource } from './dataHealth'

const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const ds = (id: string, label: string, aggregationStatus: string, h: number) => ({
    id, label, aggregationStatus, isActive: true, lastAggregatedAt: ago(h), createdAt: ago(h + 100),
})
const ws = (id: string, name: string, dataSources: unknown[], kind?: string) =>
    ({ id, name, kind, dataSources }) as unknown as WorkspaceResponse

const WORKSPACES = [
    ws('ws_fin', 'Finance Risk', [ds('ds_gl', 'General Ledger', 'ready', 5), ds('ds_risk', 'Risk Models', 'failed', 26)]),
    ws('ws_ops', 'Operations', [ds('ds_ops', 'Ops feeds', 'none', 2)]),
    ws('ws_pg', 'Playground', [ds('ds_pg', 'My sketch', 'failed', 1)], 'playground'),
]
const claims = (ws: Record<string, string[]>) => ({ sid: 't', global: [], ws })

describe('readableSources', () => {
    it('keeps the sources the reader may read, in team workspaces only', () => {
        const rows = readableSources(WORKSPACES, claims({
            ws_fin: ['workspace:datasource:read', 'workspace:datasource:manage'],
            ws_ops: ['workspace:view:read'],
            ws_pg: ['workspace:datasource:read'],
        }))
        expect(rows.map(r => r.id)).toEqual(['ds_gl', 'ds_risk'])
        expect(rows.every(r => r.canManage && r.workspaceName === 'Finance Risk')).toBe(true)
    })

    it('marks who may only read', () => {
        const rows = readableSources(WORKSPACES, claims({ ws_ops: ['workspace:datasource:read'] }))
        expect(rows).toMatchObject([{ id: 'ds_ops', canManage: false }])
    })
})

describe('healthOf', () => {
    it('says each build state as one of five', () => {
        expect(healthOf({ status: 'failed' })).toBe('failed')
        expect(healthOf({ status: 'running' })).toBe('processing')
        expect(healthOf({ status: 'pending' })).toBe('processing')
        expect(healthOf({ status: 'none' })).toBe('not-built')
        expect(healthOf({ status: 'ready' })).toBe('healthy')
    })

    it('calls a ready source behind only when projection health says so — unknown is not behind', () => {
        expect(healthOf({ status: 'ready' }, { projectorCurrent: false, projectionCommitsBehind: 3 })).toBe('behind')
        expect(healthOf({ status: 'ready' }, { projectorCurrent: null })).toBe('healthy')
    })
})

describe('summarizeDataHealth and recentDataChanges', () => {
    const rated = (id: string, health: RatedSource['health'], label: string, h: number): RatedSource => ({
        id, label, health, workspaceId: 'ws', workspaceName: 'W', status: 'ready',
        lastAggregatedAt: ago(h), createdAt: ago(h + 50), canManage: true,
    })
    const rows = [
        rated('a', 'not-built', 'Alpha', 9), rated('b', 'behind', 'Bravo', 1), rated('c', 'failed', 'Charlie', 30),
        rated('d', 'processing', 'Delta', 3), rated('e', 'healthy', 'Echo', 2),
    ]

    it('counts each state, and lists what needs a look worst first', () => {
        const s = summarizeDataHealth(rows)
        expect(s.counts).toEqual({ failed: 1, behind: 1, processing: 1, 'not-built': 1, healthy: 1 })
        expect(s.attention.map(r => r.label)).toEqual(['Charlie', 'Bravo', 'Alpha'])
        expect(s.processing.map(r => r.label)).toEqual(['Delta'])
    })

    it('puts the latest rebuilds and additions first', () => {
        const changes = recentDataChanges(rows, 3)
        expect(changes.map(c => `${c.source.label}:${c.kind}`)).toEqual(['Bravo:rebuilt', 'Echo:rebuilt', 'Delta:rebuilt'])
    })
})
