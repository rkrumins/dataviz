/**
 * People analytics fixtures — a believable month on a mid-sized platform, built
 * from a seeded generator so every render (unit test or screenshot) is the same.
 *
 * Two postures: `privileged` (the full lens, platform-wide, sign-ins included)
 * and `workspaceAdmin` (one workspace, the workspace lens: no sign-ins, no
 * addresses). Plus one person's documents for the person page.
 */
import type {
    ActivityEventRow, ActivityKind, PeopleDoc, PeopleLines, PersonCalendar, PersonDay, PersonDoc,
    PersonFeedPage, PersonRow, ScopeDay,
} from '../services/peopleActivityService'

function rng(seed: number) {
    let s = seed >>> 0
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0
        return s / 2 ** 32
    }
}

export const FIXTURE_NOW = '2026-11-24T12:00:00+00:00'
const END = new Date('2026-11-24T00:00:00Z')

function day(offset: number): string {
    const d = new Date(END)
    d.setUTCDate(d.getUTCDate() - offset)
    return d.toISOString().slice(0, 10)
}

const BUCKETS = Array.from({ length: 30 }, (_, i) => day(29 - i))

const NAMES = [
    'Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Pauling', 'Marie Curie',
    'Dorothy Vaughan', 'Edsger Dijkstra', 'Barbara Liskov', 'Claude Shannon', 'Hedy Lamarr', 'John McCarthy',
    'Frances Allen', 'Donald Knuth', 'Radia Perlman', 'Tim Berners-Lee', 'Margaret Hamilton', 'Ken Thompson',
    'Shafi Goldwasser', 'Vint Cerf', 'Annie Easley', 'Bjarne Stroustrup',
]

const KIND_WEIGHT: Record<ActivityKind, number> = {
    signin: 0, browse: 0.42, trace: 0.2, search: 0.16, build: 0.1, operate: 0.07, other: 0.05,
}

function people(lens: 'full' | 'workspace'): { rows: PersonRow[]; byKind: Record<ActivityKind, number[]>; signed: number[]; active: number[] } {
    const r = rng(lens === 'full' ? 7 : 11)
    const byKind = Object.fromEntries(
        (Object.keys(KIND_WEIGHT) as ActivityKind[]).map((k) => [k, BUCKETS.map(() => 0)]),
    ) as Record<ActivityKind, number[]>
    const signed = BUCKETS.map(() => 0)
    const active = BUCKETS.map(() => 0)
    const count = lens === 'full' ? NAMES.length : 12
    const rows: PersonRow[] = NAMES.slice(0, count).map((name, i) => {
        const appetite = 0.25 + r() * 0.75 * (1 - i / (count + 4))
        const values = BUCKETS.map((b) => {
            const weekday = (new Date(`${b}T00:00:00Z`).getUTCDay() + 6) % 7
            const p = weekday >= 5 ? appetite * 0.15 : appetite
            return r() < p ? Math.round(2 + r() * 22 * appetite) : 0
        })
        const kinds: Partial<Record<ActivityKind, number>> = {}
        let signIns = 0
        let idle = 0
        values.forEach((n, d) => {
            if (n > 0) active[d] += 1
            if (n > 0 || r() < 0.12) {
                signIns += 1
                signed[d] += 1
                if (n === 0) idle += 1
                byKind.signin[d] += 1
            }
            for (const k of Object.keys(KIND_WEIGHT) as ActivityKind[]) {
                const share = Math.round(n * KIND_WEIGHT[k] * (0.6 + r() * 0.8))
                if (share > 0) {
                    kinds[k] = (kinds[k] ?? 0) + share
                    byKind[k][d] += share
                }
            }
        })
        if (signIns) kinds.signin = signIns
        const actions = values.reduce((a, b) => a + b, 0)
        const previous = Math.round(actions * (0.6 + r() * 0.8))
        const activeDays = values.filter((n) => n > 0).length
        const lastIdx = values.map((n, d) => (n > 0 ? d : -1)).filter((d) => d >= 0).pop()
        const top = (Object.entries(kinds) as [ActivityKind, number][])
            .filter(([k]) => k !== 'signin').sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
        const id = `usr_${name.split(' ')[0].toLowerCase()}`
        return {
            userId: id,
            name,
            email: lens === 'full' ? `${name.split(' ')[0].toLowerCase()}@corp.example` : undefined,
            deleted: false,
            actions,
            previous,
            changePct: previous ? Math.round(((actions - previous) / previous) * 1000) / 10 : null,
            activeDays,
            signIns: lens === 'full' ? signIns : null,
            signInDays: lens === 'full' ? signIns : null,
            idleSignInDays: lens === 'full' ? idle : null,
            lastActiveAt: lastIdx != null ? `${BUCKETS[lastIdx]}T${String(9 + (i % 8)).padStart(2, '0')}:24:00+00:00` : null,
            lastSignInAt: lens === 'full' ? `${BUCKETS[29]}T08:${String(10 + i).padStart(2, '0')}:00+00:00` : null,
            topKind: top,
            line: values,
            joinedInWindow: i === count - 2,
            joinedAt: `2026-0${1 + (i % 9)}-1${i % 9}T10:00:00+00:00`,
            firstActiveAt: `2026-0${1 + (i % 9)}-2${i % 8}T10:00:00+00:00`,
            lastActiveEverAt: null,
        }
    })
    if (lens === 'workspace') byKind.signin = BUCKETS.map(() => 0)
    rows.sort((a, b) => b.actions - a.actions)
    return { rows, byKind, signed, active }
}

function punchcard(seed: number): number[][] {
    const r = rng(seed)
    return Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
        const work = d < 5 && h >= 8 && h <= 18
        const peak = h === 10 || h === 14 ? 2 : 1
        return work ? Math.round((8 + r() * 30) * peak) : r() < 0.08 ? Math.round(r() * 6) : 0
    }))
}

function rosterDoc(lens: 'full' | 'workspace'): PeopleDoc {
    const full = lens === 'full'
    const { rows, byKind, signed, active } = people(lens)
    const kinds = (Object.keys(byKind) as ActivityKind[])
        .filter((k) => full || k !== 'signin')
        .map((k) => ({ kind: k, count: byKind[k].reduce((a, b) => a + b, 0) }))
    const actions = rows.reduce((a, p) => a + p.actions, 0)
    const quiet = full ? 41 : 3
    return {
        generatedAt: FIXTURE_NOW,
        window: { days: 30, start: '2026-10-25T12:00:00+00:00', end: FIXTURE_NOW, granularity: 'day', buckets: BUCKETS },
        scope: { workspaceId: full ? null : 'ws_atlas', lens },
        coverage: {
            ledgerThrough: FIXTURE_NOW, sectionsSince: '2026-11-02T09:00:00+00:00',
            index: {
                freshAt: FIXTURE_NOW, completeFrom: '2025-10-20', historyFrom: '2025-10-20',
                running: true, backfilling: false, progress: 1,
            },
        },
        totals: {
            activePeople: { current: rows.filter((p) => p.actions).length, previous: full ? 17 : 10, changePct: full ? 29.4 : 10 },
            signedIn: full ? { current: rows.length, previous: 20, changePct: 10 } : null,
            actions: { current: actions, previous: Math.round(actions * 0.82), changePct: 22 },
            avgActiveDays: Math.round((rows.reduce((a, p) => a + p.activeDays, 0) / rows.length) * 10) / 10,
            idleSignIns: full ? { days: 38, signInDays: 214, rate: 0.178 } : null,
            newcomers: 1,
            members: full ? null : rows.length + quiet,
            quiet,
        },
        series: {
            buckets: BUCKETS,
            byKind: (Object.keys(byKind) as ActivityKind[]).filter((k) => full || k !== 'signin')
                .map((k) => ({ kind: k, values: byKind[k] })),
            activePeople: active,
            signedIn: full ? signed : null,
        },
        kinds,
        types: [
            { type: 'view.opened', kind: 'browse', label: 'Opened a view', count: kinds.find((k) => k.kind === 'browse')?.count ?? 0 },
            { type: 'lineage.trace', kind: 'trace', label: 'Traced lineage', count: Math.round((kinds.find((k) => k.kind === 'trace')?.count ?? 0) * 0.86) },
            { type: 'graph.search', kind: 'search', label: 'Searched the graph', count: Math.round((kinds.find((k) => k.kind === 'search')?.count ?? 0) * 0.9) },
            { type: 'edit.updated', kind: 'build', label: 'Edited a view', count: 212 },
            { type: 'aggregation.job.started', kind: 'operate', label: 'Started an aggregation', count: 88 },
            { type: 'lineage.trace_empty', kind: 'trace', label: 'Traced lineage and found none', count: 61 },
            { type: 'graph.search_miss', kind: 'search', label: 'Searched and found nothing', count: 47 },
            { type: 'edit.created', kind: 'build', label: 'Created a view', count: 31 },
        ],
        punchcard: punchcard(full ? 3 : 5),
        sections: [
            { section: 'explore', count: 1240, people: 19 },
            { section: 'workspaces', count: 610, people: 17 },
            { section: 'dashboard', count: 402, people: 21 },
            { section: 'analytics', count: 96, people: 4 },
            { section: 'schema', count: 71, people: 6 },
            { section: 'ingestion', count: 44, people: 3 },
        ],
        insights: full ? [
            { key: 'people-active-change', tone: 'good', headline: 'Active people up 29% in the last 30 days', detail: '22 people did something, against 17 in the period before.', tab: null, spark: active },
            { key: 'people-concentration', tone: 'watch', headline: 'The most active 10% of people do 51% of the work', detail: 'Usage leans on a few people. If they move on, so does the habit.', tab: null, spark: null },
            { key: 'people-peak-hour', tone: 'neutral', headline: 'Busiest on Tuesdays around 14:00 UTC', detail: 'A good time for changes people should see, and a bad time for maintenance.', tab: null, spark: null },
        ] : [
            { key: 'people-quiet-members', tone: 'neutral', headline: '3 of 15 members did nothing here in the last 30 days', detail: 'They still have access. A nudge, or a review of who needs it, is the next step.', tab: null, spark: null },
        ],
        people: rows.slice(0, 25),
        quiet: {
            count: quiet,
            people: [
                { userId: 'usr_rosalind', name: 'Rosalind Franklin', email: full ? 'rosalind@corp.example' : undefined, joinedAt: '2026-03-02T10:00:00+00:00', lastLoginAt: full ? '2026-09-14T09:00:00+00:00' : null, lastActiveAt: '2026-09-12T15:30:00+00:00' },
                { userId: 'usr_charles', name: 'Charles Babbage', email: full ? 'charles@corp.example' : undefined, joinedAt: '2026-05-19T10:00:00+00:00', lastLoginAt: null, lastActiveAt: '2026-08-02T11:00:00+00:00' },
                { userId: 'usr_mary', name: 'Mary Jackson', email: full ? 'mary@corp.example' : undefined, joinedAt: '2026-10-30T10:00:00+00:00', lastLoginAt: null, lastActiveAt: null },
            ],
        },
        page: { offset: 0, limit: 25, total: rows.length },
    }
}

export const PEOPLE_FIXTURES = {
    privileged: rosterDoc('full'),
    workspaceAdmin: rosterDoc('workspace'),
}

// ── One person ─────────────────────────────────────────────────────────

const PERSON_ID = 'usr_ada'

export function personCalendar(): PersonCalendar {
    const r = rng(42)
    const days = Array.from({ length: 365 }, (_, i) => day(364 - i))
    const actions = days.map((d, i) => {
        const weekday = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7
        const season = 0.55 + 0.45 * Math.sin(i / 40)
        if (i > 150 && i < 165) return 0          // a holiday
        return weekday < 5 && r() < 0.8 * season ? Math.round(3 + r() * 30 * season) : 0
    })
    const signIns = actions.map((n) => (n > 0 ? 1 + Math.round(r()) : r() < 0.06 ? 1 : 0))
    return { generatedAt: FIXTURE_NOW, scope: { workspaceId: null, lens: 'full' }, days, actions, signIns }
}

export function personDoc(): PersonDoc {
    const roster = PEOPLE_FIXTURES.privileged
    const me = roster.people.find((p) => p.userId === PERSON_ID) ?? roster.people[0]
    const byKind = (['signin', 'browse', 'trace', 'search', 'build', 'operate', 'other'] as ActivityKind[]).map((k) => ({
        kind: k,
        values: me.line.map((n, i) => (k === 'signin' ? (n > 0 ? 1 : 0) : Math.round(n * KIND_WEIGHT[k] * (1 + ((i * 7) % 5) / 10)))),
    }))
    const actions = me.line
    const previousActions = me.line.map((n, i) => Math.max(0, Math.round(n * 0.7 + ((i * 5) % 7) - 3)))
    return {
        generatedAt: FIXTURE_NOW,
        window: roster.window,
        scope: { workspaceId: null, lens: 'full' },
        coverage: roster.coverage,
        profile: {
            userId: PERSON_ID, name: 'Ada Lovelace', email: 'ada@corp.example', status: 'active',
            createdAt: '2025-11-03T09:12:00+00:00', deleted: false,
            lastLoginAt: '2026-11-24T08:02:00+00:00', lastSeenAt: '2026-11-24T11:40:00+00:00',
            lastActiveAt: '2026-11-24T11:31:00+00:00', firstActiveAt: '2025-11-03T09:40:00+00:00',
        },
        totals: {
            actions: { current: me.actions, previous: me.previous, changePct: me.changePct },
            activeDays: { current: me.activeDays, previous: me.activeDays - 3, changePct: 17.6 },
            signIns: { current: 24, previous: 19, changePct: 26.3 },
            idleSignInDays: 2,
            viewsOpened: { current: 184, previous: 151, changePct: 21.9 },
            distinctViews: 23,
            traces: { current: 96, previous: 70, changePct: 37.1 },
            traceEmptyRate: 0.083,
            searches: { current: 61, previous: 66, changePct: -7.6 },
            searchMissRate: 0.131,
            longestStreak: 9,
            currentStreak: 4,
            lastActiveAt: '2026-11-24T11:31:00+00:00',
        },
        series: {
            buckets: roster.window.buckets, byKind,
            activePeople: actions.map((n) => (n ? 1 : 0)), signedIn: actions.map((n) => (n ? 1 : 0)),
            actions, previousActions, signIns: actions.map((n) => (n ? 1 : 0)),
        },
        kinds: byKind.map((s) => ({ kind: s.kind, count: s.values.reduce((a, b) => a + b, 0) })),
        types: roster.types.slice(0, 6).map((t) => ({ ...t, count: Math.round(t.count / 9) })),
        punchcard: punchcard(9),
        sections: roster.sections.map((s) => ({ ...s, count: Math.round(s.count / 12), people: 1 })),
        typicalDay: { firstMinute: 8 * 60 + 47, lastMinute: 17 * 60 + 22, days: me.activeDays },
        workspaces: [
            { workspaceId: 'ws_atlas', name: 'Atlas', locked: false, canOpen: true, actions: 312, joinedAt: '2025-11-03T09:12:00+00:00', firstActiveAt: '2025-11-03T09:40:00+00:00', lastActiveAt: '2026-11-24T11:31:00+00:00', member: true },
            { workspaceId: 'ws_borealis', name: 'Borealis Finance', locked: false, canOpen: true, actions: 74, joinedAt: '2026-04-14T10:00:00+00:00', firstActiveAt: '2026-04-15T08:20:00+00:00', lastActiveAt: '2026-11-20T16:05:00+00:00', member: true },
            { workspaceId: 'ws_cobalt', name: 'Cobalt Risk', locked: false, canOpen: false, actions: 0, joinedAt: '2026-02-01T10:00:00+00:00', firstActiveAt: '2026-02-03T13:00:00+00:00', lastActiveAt: '2026-07-30T10:10:00+00:00', member: false },
        ],
        views: [
            { id: 'view_rev', name: 'Revenue lineage', locked: false, deleted: false, workspaceId: 'ws_atlas', canOpen: true, opens: 48 },
            { id: 'view_cust', name: 'Customer 360', locked: false, deleted: false, workspaceId: 'ws_atlas', canOpen: true, opens: 31 },
            { id: 'view_gl', name: 'General ledger flows', locked: false, deleted: false, workspaceId: 'ws_borealis', canOpen: true, opens: 22 },
            { id: null, name: null, locked: true, deleted: false, workspaceId: null, canOpen: false, opens: 9 },
        ],
        signIns: {
            methods: [{ key: 'okta', count: 21 }, { key: 'local', count: 3 }],
            recent: [
                { at: '2026-11-24T08:02:00+00:00', method: 'okta' },
                { at: '2026-11-21T08:11:00+00:00', method: 'okta' },
                { at: '2026-11-20T13:40:00+00:00', method: 'local' },
            ],
            failed: 2,
            capped: false,
        },
        standing: { rank: 3, of: 22, percentile: 86 },
        viewer: { isSelf: false, privileged: true },
    }
}

function ev(id: string, at: string, kind: ActivityEventRow['kind'], label: string, extra: Partial<ActivityEventRow> = {}): ActivityEventRow {
    return {
        id, at, type: kind, kind, label, section: null, outcome: null, target: null,
        workspace: { workspaceId: 'ws_atlas', name: 'Atlas', locked: false, canOpen: true },
        view: null, summary: null, ...extra,
    }
}

const REV = { id: 'view_rev', name: 'Revenue lineage', locked: false, deleted: false, workspaceId: 'ws_atlas', canOpen: true }

export function personDay(dayIso = day(1)): PersonDay {
    const t = (hhmm: string) => `${dayIso}T${hhmm}:00+00:00`
    const events: ActivityEventRow[] = [
        ev('e1', t('08:02'), 'signin', 'Signed in', { workspace: null }),
        ev('e2', t('08:03'), 'section', 'Went to a section', { section: 'explore', workspace: null }),
        ev('e3', t('08:05'), 'browse', 'Opened a view', { view: REV }),
        ev('e4', t('08:09'), 'trace', 'Traced lineage', { view: null }),
        ev('e5', t('08:21'), 'trace', 'Traced lineage'),
        ev('e6', t('08:40'), 'build', 'Edited a view', { view: REV, summary: 'Added the "Billing" layer' }),
        ev('e7', t('13:12'), 'search', 'Searched the graph'),
        ev('e8', t('13:15'), 'browse', 'Opened a view', { view: { ...REV, id: 'view_cust', name: 'Customer 360' } }),
        ev('e9', t('13:30'), 'operate', 'Started an aggregation', { target: { type: 'data_source', id: 'ds_1', label: 'Snowflake prod' } }),
        ev('e10', t('16:55'), 'search', 'Searched and found nothing'),
    ]
    return {
        day: dayIso, scope: { workspaceId: null, lens: 'full' }, events,
        sessions: [
            { start: t('08:02'), end: t('08:40'), actions: 4, kinds: { signin: 1, section: 1, browse: 1, trace: 2, build: 1 } },
            { start: t('13:12'), end: t('13:30'), actions: 3, kinds: { search: 1, browse: 1, operate: 1 } },
            { start: t('16:55'), end: t('16:55'), actions: 1, kinds: { search: 1 } },
        ],
        truncated: false,
        kinds: { signin: 1, section: 1, browse: 2, trace: 2, build: 1, search: 2, operate: 1 },
    }
}

export function personFeed(): PersonFeedPage {
    const a = personDay(day(1)).events
    const b = personDay(day(2)).events.map((e) => ({ ...e, id: `${e.id}b` }))
    const events = [...a, ...b].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
    return { scope: { workspaceId: null, lens: 'full' }, events, next: null }
}

export { PERSON_ID }


/** The compare chart's lines for the given people. */
export function peopleLines(ids: string[]): PeopleLines {
    const roster = PEOPLE_FIXTURES.privileged
    const byId = new Map(roster.people.map((p) => [p.userId, p]))
    const pick = ids.filter((id) => byId.has(id))
    return {
        buckets: roster.window.buckets, granularity: 'day',
        lines: Object.fromEntries(pick.map((id) => [id, byId.get(id)!.line])),
        names: Object.fromEntries(pick.map((id) => [id, byId.get(id)!.name])),
        scope: roster.scope,
    }
}

/** Everyone active on one day of the fixture month. */
export function scopeDay(dayIso: string): ScopeDay {
    const roster = PEOPLE_FIXTURES.privileged
    const i = Math.max(0, roster.window.buckets.indexOf(dayIso))
    const people = roster.people
        .map((p) => ({ p, n: p.line[i] ?? 0 }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .map(({ p, n }) => ({
            userId: p.userId, name: p.name, actions: n, signIns: 1,
            kinds: { [p.topKind ?? 'browse']: n } as ScopeDay['people'][number]['kinds'],
        }))
    return {
        day: dayIso, scope: roster.scope, active: people.length, signedIn: people.length,
        kinds: roster.series.byKind.map((s) => ({ kind: s.kind, count: s.values[i] ?? 0 })).filter((k) => k.count),
        people,
    }
}
