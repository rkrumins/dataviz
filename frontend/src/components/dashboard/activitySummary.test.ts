/**
 * "Busiest views" listed "Impact Analysis" and "Data Lineage" TWICE each. Those
 * are different views that share a name — honest data — but two identical rows
 * with different counts read as a counting bug.
 *
 * The rule: suffix a row with its workspace ONLY when another row shares its
 * name. Labelling every row would be noise; labelling none leaves twins.
 */
import { describe, it, expect } from 'vitest'
import { summarise } from './activitySummary'
import type { ViewActivityEntry } from '@/services/viewApiService'

const WORKSPACES: Record<string, string> = { ws_1: 'Finance', ws_2: 'Ops' }
const nameFor = (id?: string | null) => (id ? WORKSPACES[id] : undefined)

const ev = (over: Partial<ViewActivityEntry> & { id: string }): ViewActivityEntry => ({
    action: 'updated',
    actor: 'u1',
    actorName: 'System Admin',
    actorEmail: null,
    summary: null,
    changes: null,
    createdAt: '2026-07-13T10:00:00Z',
    viewId: 'v1',
    viewName: 'Data Lineage',
    workspaceId: 'ws_1',
    ...over,
} as ViewActivityEntry)

describe('summarise → busiest views', () => {
    it('suffixes the workspace when two DIFFERENT views share a name', () => {
        const { busiest } = summarise([
            ev({ id: 'a', viewId: 'v1', viewName: 'Data Lineage', workspaceId: 'ws_1' }),
            ev({ id: 'b', viewId: 'v2', viewName: 'Data Lineage', workspaceId: 'ws_2' }),
        ], nameFor)

        expect(busiest).toHaveLength(2)
        expect(busiest.map(v => v.workspaceName).sort()).toEqual(['Finance', 'Ops'])
    })

    it('does NOT suffix a name that is unique — that would just be noise', () => {
        const { busiest } = summarise([
            ev({ id: 'a', viewId: 'v1', viewName: 'Data Lineage' }),
            ev({ id: 'b', viewId: 'v2', viewName: 'Impact Analysis' }),
        ], nameFor)

        expect(busiest.every(v => v.workspaceName === undefined)).toBe(true)
    })

    it('counts repeat events on ONE view without treating it as a collision', () => {
        const { busiest } = summarise([
            ev({ id: 'a', viewId: 'v1' }),
            ev({ id: 'b', viewId: 'v1' }),
            ev({ id: 'c', viewId: 'v1' }),
        ], nameFor)

        expect(busiest).toHaveLength(1)
        expect(busiest[0].count).toBe(3)
        expect(busiest[0].workspaceName).toBeUndefined()
    })

    it('ranks busiest first and keeps the top 4', () => {
        const entries = [
            ...Array.from({ length: 3 }, (_, i) => ev({ id: `a${i}`, viewId: 'v1', viewName: 'Three' })),
            ...Array.from({ length: 5 }, (_, i) => ev({ id: `b${i}`, viewId: 'v2', viewName: 'Five' })),
            ev({ id: 'c', viewId: 'v3', viewName: 'One' }),
            ev({ id: 'd', viewId: 'v4', viewName: 'Two' }),
            ev({ id: 'e', viewId: 'v4', viewName: 'Two' }),
            ev({ id: 'f', viewId: 'v5', viewName: 'Also one' }),
        ]
        const { busiest } = summarise(entries, nameFor)

        expect(busiest).toHaveLength(4)
        expect(busiest.map(v => v.viewName)).toEqual(['Five', 'Three', 'Two', 'One'])
    })

    it('still splits the channels', () => {
        const { peopleChanges, dataUpdates, total } = summarise([
            ev({ id: 'a', action: 'created' }),
            ev({ id: 'b', action: 'data_changed' }),
            ev({ id: 'c', action: 'data_changed' }),
        ], nameFor)

        expect(total).toBe(3)
        expect(peopleChanges).toBe(1)
        expect(dataUpdates).toBe(2)
    })

    it('falls back gracefully when the workspace is unknown', () => {
        const { busiest } = summarise([
            ev({ id: 'a', viewId: 'v1', viewName: 'Twin', workspaceId: 'ws_missing' }),
            ev({ id: 'b', viewId: 'v2', viewName: 'Twin', workspaceId: null }),
        ], nameFor)

        // Ambiguous, but we don't know where they live — show the name, not "· undefined".
        expect(busiest.every(v => v.workspaceName === undefined)).toBe(true)
    })
})
