/**
 * The explorer's pure parts: what it asks the server, how it folds the
 * timeline, and where an event links to.
 */
import { describe, expect, it } from 'vitest'

import {
    activityBase,
    activityQueryString,
    type ActivityEvent,
    type ActivityQuery,
    type ActivitySummary,
} from '@/services/activityService'
import { busiestSlot, punchcardTable } from '@/components/analytics/charts/punchcard'

import { activityLinks } from '../activityLinks'
import { groupEvents } from '../groupEvents'
import { attentionItems } from '../attention'
import {
    cadencePhrase, isPersonId, reasonExpected, retentionPhrase, spanToRange, workspaceActivityScope,
} from '../activityMeta'

const Q: ActivityQuery = { range: { kind: 'preset', days: 30 } }

function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
    return {
        id: 'e', eventType: 'aggregation.job.triggered', label: 'Triggered aggregation',
        category: 'operations', severity: 'info', outcome: 'success',
        summary: 'Triggered aggregation of Ledger',
        occurredAt: '2026-10-11T09:00:00+00:00', recordedAt: '2026-10-11T09:00:00+00:00',
        actorKind: 'user', actor: { id: 'usr_ana', name: 'Ana', deleted: false },
        target: { type: 'data_source', id: 'ds_1', label: 'Ledger' },
        workspaceId: 'ws_1', dataSourceId: 'ds_1', details: {}, resolvedNames: {},
        ...over,
    }
}

describe('what the explorer asks for', () => {
    it('reads a workspace admin\'s scope from the workspace endpoint, and never names the workspace in a filter', () => {
        const scope = { kind: 'workspace', workspaceId: 'ws 1' } as const
        expect(activityBase(scope)).toBe('/api/v1/admin/workspaces/ws%201/activity')
        // Even a stray workspace filter cannot ride along: the server pins it.
        expect(activityQueryString(scope, { ...Q, workspaceId: 'ws_other' })).not.toContain('workspaceId')
    })

    it('reads an auditor\'s view of one workspace from the platform log, pinned to it', () => {
        const scope = { kind: 'workspace', workspaceId: 'ws_1', asAuditor: true } as const
        expect(activityBase(scope)).toBe('/api/v1/admin/activity')
        const qs = new URLSearchParams(activityQueryString(scope, { ...Q, workspaceId: 'ws_other' }))
        expect(qs.get('workspaceId')).toBe('ws_1')
    })

    it('spells a selection one way, so equal selections share a cache entry', () => {
        const qs = activityQueryString({ kind: 'platform' }, {
            ...Q, categories: ['identity', 'access'], eventTypes: ['user.*'], person: ' ana ',
            personRole: 'actor', outcome: 'denied', hasReason: false, includeNoise: true, q: ' rebuild ',
        })
        expect(qs).toBe(
            'days=30&category=identity%2Caccess&eventType=user.*&person=ana&personRole=actor'
            + '&outcome=denied&hasReason=false&includeNoise=true&q=rebuild',
        )
    })

    it('sends a person\'s part only with a person', () => {
        expect(activityQueryString({ kind: 'platform' }, { ...Q, personRole: 'subject' })).toBe('days=30')
    })
})

describe('the timeline folds repeats, not distinct facts', () => {
    it('folds identical adjacent events and keeps the newest', () => {
        const days = groupEvents([ev({ id: 'a' }), ev({ id: 'b' }), ev({ id: 'c', statedReason: 'other' })],
            new Date('2026-10-11T12:00:00Z'))
        expect(days).toHaveLength(1)
        expect(days[0].label).toBe('Today')
        expect(days[0].rows.map((r) => [r.event.id, r.count])).toEqual([['a', 2], ['c', 1]])
    })

    it('starts a new day group when the day changes', () => {
        const days = groupEvents([
            ev({ id: 'a' }),
            ev({ id: 'b', occurredAt: '2026-10-10T09:00:00+00:00' }),
        ], new Date('2026-10-11T12:00:00Z'))
        expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday'])
    })
})

describe('when a missing reason is worth saying', () => {
    it('for a person\'s change, not for a sign-in or the platform itself', () => {
        expect(reasonExpected(ev({ statedReason: null }))).toBe(true)
        expect(reasonExpected(ev({ statedReason: 'why' }))).toBe(false)
        expect(reasonExpected(ev({ category: 'identity', statedReason: null }))).toBe(false)
        expect(reasonExpected(ev({ actorKind: 'system', statedReason: null }))).toBe(false)
    })
})

describe('where an event links to', () => {
    it('sends a run to Job History, its source to Freshness and its workspace home', () => {
        const links = activityLinks(ev({ details: { jobId: 'agg_9' } }))
        expect(links.map((l) => l.key)).toEqual(['job', 'their-runs', 'freshness', 'workspace'])
        expect(links[0].href).toBe('/ingestion?tab=jobs&dataSourceId=ds_1&search=agg_9')
        // Every other run the same person started — how often they do this.
        expect(links[1].href).toBe('/ingestion?tab=jobs&triggeredBy=usr_ana')
        expect(links[2].href).toBe('/ingestion?tab=freshness&fds=ds_1')
    })

    it('offers a person\'s runs only for a run a person started', () => {
        const automated = activityLinks(ev({ actorKind: 'system', actor: null }))
        expect(automated.map((l) => l.key)).not.toContain('their-runs')
    })

    it('opens a group by its id', () => {
        const links = activityLinks(ev({
            eventType: 'rbac.group.member_added', category: 'access',
            target: { type: 'group', id: 'grp_1' }, workspaceId: null, dataSourceId: null,
        }))
        expect(links).toEqual([{ key: 'group', label: 'Open the group', href: '/admin/groups?group=grp_1' }])
    })

    it('opens a service account by its id', () => {
        const account = activityLinks(ev({
            eventType: 'identity.service_account.disabled', category: 'access',
            target: { type: 'service_account', id: 'svc_0123456789ab' }, workspaceId: null, dataSourceId: null,
        }))
        expect(account).toEqual([{
            key: 'service-account', label: 'Open the service account',
            href: '/service-accounts/svc_0123456789ab',
        }])
    })
})

describe('reading the summary', () => {
    it('words a source\'s cadence', () => {
        expect(cadencePhrase(null)).toBeNull()
        expect(cadencePhrase(0.5)).toBe('several times an hour')
        expect(cadencePhrase(5)).toBe('every ~5h')
        expect(cadencePhrase(72)).toBe('every ~3 days')
    })

    it('finds the busiest weekday and hour, and tabulates the grid', () => {
        const grid = Array.from({ length: 7 }, () => Array(24).fill(0))
        expect(busiestSlot(grid)).toBeNull()
        grid[2][14] = 5
        grid[4][9] = 3
        expect(busiestSlot(grid)).toEqual({ day: 2, hour: 14, count: 5 })
        const table = punchcardTable(grid)
        expect(table.rows[2]).toBe('Wednesday')
        expect(table.columns[14]).toMatchObject({ label: '14:00' })
        expect(table.columns[14].values[2]).toBe(5)
    })
})

describe('who sees a workspace\'s Activity tab', () => {
    it('its admin reads the workspace log; an auditor reads the platform log pinned to it', () => {
        expect(workspaceActivityScope('ws_1', { isAdmin: true, isAuditor: false }))
            .toEqual({ kind: 'workspace', workspaceId: 'ws_1', asAuditor: false })
        expect(workspaceActivityScope('ws_1', { isAdmin: false, isAuditor: true }))
            .toEqual({ kind: 'workspace', workspaceId: 'ws_1', asAuditor: true })
        expect(workspaceActivityScope('ws_1', { isAdmin: false, isAuditor: false })).toBeNull()
        expect(workspaceActivityScope(undefined, { isAdmin: true, isAuditor: true })).toBeNull()
    })
})

describe('how long the log keeps activity', () => {
    it('says it in years when it is whole years, and in days otherwise', () => {
        expect(retentionPhrase(730)).toBe('2 years')
        expect(retentionPhrase(365)).toBe('1 year')
        expect(retentionPhrase(400)).toBe('400 days')
    })
})

describe('a spotlight is for a person picked by id', () => {
    it('not for text that could match several people', () => {
        expect(isPersonId('usr_ana')).toBe(true)
        expect(isPersonId('svc_0123456789ab')).toBe(true)
        expect(isPersonId('ana')).toBe(false)
        expect(isPersonId('ana@example.com')).toBe(false)
    })
})

describe('what needs attention', () => {
    const ANA = { id: 'usr_ana', name: 'Ana Lyst', deleted: false }
    function summary(over: {
        sources?: Partial<ActivitySummary['handsOnSources'][number]>[]
        operations?: ActivitySummary['totals']['operations']
        reasons?: ActivitySummary['totals']['reasons']
    } = {}): ActivitySummary {
        return {
            window: { days: 30, start: '', end: '', granularity: 'day', buckets: [], previousStart: '' },
            totals: {
                events: { current: 10, previous: 10, delta: 0 },
                people: { current: 2, previous: 2, delta: 0 },
                operations: over.operations ?? { current: 4, previous: 4, delta: 0 },
                reasons: over.reasons ?? { given: 9, of: 10, share: 0.9 },
            },
            volume: [], punchcard: [], topPeople: [], topTargets: [], topActions: [], topReasons: [],
            handsOnSources: (over.sources ?? []).map((s, i) => ({
                dataSourceId: `ds_${i}`, count: 8, lastAt: '', medianGapHours: 6, name: `Source ${i}`, people: [],
                ...s,
            })),
            cadenceCapped: false,
        }
    }

    it('has nothing to say about a quiet, well-explained range', () => {
        expect(attentionItems(summary({ sources: [{ count: 2 }, { medianGapHours: 200 }] }))).toEqual([])
    })

    it('calls a source run by hand at least daily toil, most frequent first, and narrows to it', () => {
        const items = attentionItems(summary({ sources: [{ medianGapHours: 20 }, { medianGapHours: 3 }] }))
        expect(items.map((i) => i.title)).toEqual([
            'Source 1 is run by hand every ~3h',
            'Source 0 is run by hand every ~20h',
        ])
        expect(items[0].show).toEqual({ dataSource: 'ds_1' })
        expect(items[0].detail).toBe('8 manual operations in this range. A schedule could take this over.')
    })

    it('names the one person behind a source, unless the selection is already theirs', () => {
        const sole = summary({ sources: [{ people: [{ ...ANA, count: 8 }] }] })
        expect(attentionItems(sole)[0].detail).toContain('all by Ana Lyst')
        expect(attentionItems(sole, { personFiltered: true })[0].detail).not.toContain('Ana')

        const carried = summary({ sources: [{ medianGapHours: 96, people: [{ ...ANA, count: 8 }] }] })
        expect(attentionItems(carried)).toEqual([expect.objectContaining({
            kind: 'one-person', title: 'Only Ana Lyst operates Source 0', show: { dataSource: 'ds_0' },
        })])
        expect(attentionItems(carried, { personFiltered: true })).toEqual([])
        // Shared work is not one person's.
        expect(attentionItems(summary({ sources: [{ medianGapHours: 96, people: [{ ...ANA, count: 5 }] }] })))
            .toEqual([])
    })

    it('flags manual work rising sharply, but not a small or incomparable change', () => {
        expect(attentionItems(summary({ operations: { current: 18, previous: 10, delta: 0.8 } }))).toEqual([
            expect.objectContaining({
                title: 'Manual operations are up 80%',
                detail: '18 in this range against 10 the period before. Something upstream may need fixing.',
                show: { lens: 'operations', types: null },
            }),
        ])
        expect(attentionItems(summary({ operations: { current: 6, previous: 3, delta: 1 } }))).toEqual([])
        expect(attentionItems(summary({ operations: { current: 40, previous: null, delta: null } }))).toEqual([])
    })

    it('flags changes that mostly do not say why, and shows the ones that did not', () => {
        expect(attentionItems(summary({ reasons: { given: 4, of: 40, share: 0.1 } }))).toEqual([
            expect.objectContaining({
                title: 'Most changes don’t say why',
                detail: 'Only 4 of 40 changes in this range gave a reason.',
                show: { reason: 'missing' },
            }),
        ])
        expect(attentionItems(summary({ reasons: { given: 1, of: 5, share: 0.2 } }))).toEqual([])
    })

    it('says at most three things', () => {
        const items = attentionItems(summary({
            sources: [{ medianGapHours: 2 }, { medianGapHours: 4 }],
            operations: { current: 18, previous: 10, delta: 0.8 },
            reasons: { given: 4, of: 40, share: 0.1 },
        }))
        expect(items.map((i) => i.kind)).toEqual(['toil', 'toil', 'surge'])
    })
})

describe('a span picked on the chart is a range of days', () => {
    it('from the first day to the last, for day buckets', () => {
        expect(spanToRange(['2026-10-01', '2026-10-02', '2026-10-03'], 'day', 0, 1, '2026-10-03'))
            .toEqual({ kind: 'custom', from: '2026-10-01', to: '2026-10-02' })
    })

    it('to the end of the last week, but never past the window', () => {
        const weeks = ['2026-07-01', '2026-07-08', '2026-07-15']
        expect(spanToRange(weeks, 'week', 0, 1, '2026-07-18'))
            .toEqual({ kind: 'custom', from: '2026-07-01', to: '2026-07-14' })
        expect(spanToRange(weeks, 'week', 1, 2, '2026-07-18'))
            .toEqual({ kind: 'custom', from: '2026-07-08', to: '2026-07-18' })
    })
})
