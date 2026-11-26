import { describe, expect, it } from 'vitest'

import { ACTIVITY_KINDS } from '@/services/peopleActivityService'
import { KIND_META, kindsFor } from '../activityKinds'
import { personActivityHref, spanToRange } from '../peopleLinks'

describe('people links', () => {
    it('carries the range and the workspace to a person', () => {
        expect(personActivityHref('usr_a', { range: { kind: 'preset', days: 30 }, workspaceId: 'ws_1' }))
            .toBe('/analytics/people/usr_a?range=30&workspace=ws_1')
        expect(personActivityHref('usr_a', { range: { kind: 'custom', from: '2026-01-01', to: '2026-01-31' }, day: '2026-01-04' }))
            .toBe('/analytics/people/usr_a?from=2026-01-01&to=2026-01-31&day=2026-01-04')
    })

    it('ends a weekly span six days on, but never past its window', () => {
        const weeks = ['2026-01-01', '2026-01-08', '2026-01-15']
        expect(spanToRange(weeks, 'week', 0, 1, '2026-01-20T12:00:00+00:00'))
            .toEqual({ kind: 'custom', from: '2026-01-01', to: '2026-01-14' })
        expect(spanToRange(weeks, 'week', 2, 2, '2026-01-18T12:00:00+00:00'))
            .toEqual({ kind: 'custom', from: '2026-01-15', to: '2026-01-18' })
        expect(spanToRange(['2026-01-01', '2026-01-02'], 'day', 1, 1, '2026-01-02T12:00:00+00:00'))
            .toEqual({ kind: 'custom', from: '2026-01-02', to: '2026-01-02' })
    })
})

describe('activity kinds', () => {
    it('mirror the server, in its order', () => {
        // `KINDS` in people_activity_repo.py — test_the_kinds_are_the_clients_kinds pins the other side.
        expect([...ACTIVITY_KINDS]).toEqual(['signin', 'browse', 'trace', 'search', 'build', 'operate', 'other'])
    })

    it('never repeat a colour: six slots, one residual', () => {
        const slots = ACTIVITY_KINDS.map((k) => KIND_META[k].slot).filter((s) => s !== undefined)
        expect(new Set(slots).size).toBe(slots.length)
        expect(KIND_META.other.slot).toBeUndefined()
    })

    it('leave sign-ins out of the workspace lens', () => {
        expect(kindsFor('workspace')).not.toContain('signin')
        expect(kindsFor('full')).toContain('signin')
    })
})
