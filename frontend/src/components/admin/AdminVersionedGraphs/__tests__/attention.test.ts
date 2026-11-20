/**
 * What needs attention, built only from what the Overview reads: the fleet's figures (failing graphs,
 * graphs waiting for room), the signals at or past their mark over the 24 hours a mark is set for,
 * what is staged, and the platform's values (a value the server adjusted whose why carries a fix; a
 * deployment value it ignored). Each kind, and the order of importance they come in.
 */
import { describe, expect, it } from 'vitest'
import { SCHEMA } from '@/components/settings/__fixtures__/schema'
import { PLATFORM_VALUES, SIGNAL_COUNTS } from '@/components/settings/__fixtures__/resolved'
import type { ResolvedSetting, ResolvedValues, Signal, SignalCount } from '@/components/settings'
import { needsAttention, type AttentionInput, type AttentionItem } from '../attention'
import { SUMMARY } from '../__fixtures__/api'

const why = (code: string) => ({ code, text: SCHEMA.why[code].text, fix: SCHEMA.why[code].fix })

/** Nothing read, nothing staged: each test adds what it is about. */
const NOTHING: AttentionInput = {
    summary: undefined, signals: undefined, definitions: SCHEMA.signals, settings: SCHEMA.settings, values: undefined, staged: 0, problems: 0,
}
const CALM = { ...SUMMARY, failing: 0, waitingForRoom: 0 }

const kinds = (items: AttentionItem[]) => items.map((a) => a.kind)
const symptom = (id: string) => SCHEMA.signals.find((s) => s.id === id)!.symptom

/** The platform's values with `changes` over them. */
function values(changes: Record<string, Partial<ResolvedSetting>>): ResolvedValues {
    return Object.fromEntries(Object.entries(PLATFORM_VALUES).map(([k, r]) => [k, { ...r, ...changes[k] }]))
}

describe('needsAttention', () => {
    it('says nothing it wasn’t given: no figures, signals or values read, nothing staged', () => {
        expect(needsAttention(NOTHING)).toEqual([])
    })

    it('lists failing graphs and graphs waiting for room, as the figures count them', () => {
        expect(needsAttention({ ...NOTHING, summary: SUMMARY })).toEqual([
            { kind: 'failing', id: 'failing', count: SUMMARY.failing },
            { kind: 'waiting', id: 'waiting', count: SUMMARY.waitingForRoom },
        ])
        expect(needsAttention({ ...NOTHING, summary: CALM })).toEqual([])
    })

    it('lists a problem whose signals reached their mark in the last 24 hours, the furthest past it first', () => {
        // Loads waited for room 38 times (mark 30), the guard stopped one replace (mark 1); the rest are under their
        // marks, or have none.
        const items = needsAttention({ ...NOTHING, signals: SIGNAL_COUNTS })
        expect(items.map((a) => a.kind === 'signal' && a.symptom)).toEqual([
            symptom('residency.load_waited_for_room'), symptom('imports.replace_refused_by_guard'),
        ])
        const first = items[0] as Extract<AttentionItem, { kind: 'signal' }>
        expect(first.happened.map((h) => [h.signal.id, h.count])).toEqual([['residency.load_waited_for_room', 38]])
    })

    it('holds a count to its mark only over the 24 hours the mark is set for, and never a count of 0', () => {
        const loads = SCHEMA.signals.find((s) => s.id === 'residency.load_waited_for_room')!
        const hour: SignalCount[] = [{ id: loads.id, count: 300, window: '1h' }]
        expect(needsAttention({ ...NOTHING, signals: hour })).toEqual([])
        const free: Signal[] = [{ ...loads, warnAt: 0 }]
        expect(needsAttention({ ...NOTHING, definitions: free, signals: [{ id: loads.id, count: 0, window: '24h' }] })).toEqual([])
        // A count the registry doesn't name isn't guessed at.
        expect(needsAttention({ ...NOTHING, signals: [{ id: 'something.new', count: 99, window: '24h' }] })).toEqual([])
    })

    it('lists a problem once, with every signal past its mark that answers it', () => {
        const [a, b] = SCHEMA.signals.filter((s) => s.warnAt !== null)
        const definitions: Signal[] = [{ ...a, warnAt: 5 }, { ...b, warnAt: 5, symptom: a.symptom.toUpperCase() }]
        const items = needsAttention({
            ...NOTHING, definitions, signals: [{ id: a.id, count: 6, window: '24h' }, { id: b.id, count: 9, window: '24h' }],
        })
        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({ kind: 'signal', symptom: a.symptom })
        expect((items[0] as Extract<AttentionItem, { kind: 'signal' }>).happened.map((h) => h.count)).toEqual([6, 9])
    })

    it('lists what is staged and not saved, with how many need a fix first', () => {
        expect(needsAttention({ ...NOTHING, staged: 3, problems: 1 })).toEqual([{ kind: 'staged', id: 'staged', count: 3, problems: 1 }])
    })

    it('lists a value the server adjusted whose why carries the fix; not one held for a reason with none, nor one dormant by choice', () => {
        const adjusted = values({
            'reads.mode': { declared: 'beside', effective: 'in_place', status: 'adjusted', why: [why('builds_off')] },
            // Capped by the deployment: adjusted, with nothing to do here.
            'database.readsPerProcess': { status: 'adjusted', why: [why('capped_by_deployment')] },
        })
        const items = needsAttention({ ...NOTHING, values: adjusted })
        const fixes = items.filter((a): a is Extract<AttentionItem, { kind: 'fix' }> => a.kind === 'fix')
        expect(fixes.map((a) => [a.setting.key, a.why.code, a.fix])).toEqual([['reads.mode', 'builds_off', { feature: 'candidateKeysEnabled', to: true }]])
        // Every builds setting is dormant with New-version builds off, and its why says how to turn them on: a switch
        // left off is the platform's choice, not something to fix.
        expect(Object.values(PLATFORM_VALUES).filter((r) => r.status === 'dormant' && r.why.some((w) => w.fix)).length).toBeGreaterThan(0)
        expect(fixes.some((a) => a.setting.category === 'builds')).toBe(false)
    })

    it('lists a value whose deployment value was ignored: not valid, or out of its range', () => {
        const outOfRange = values({
            'drafts.idleCloseDays': { status: 'adjusted', why: [why('env_out_of_range')] },
        })
        const items = needsAttention({ ...NOTHING, values: outOfRange })
        expect(items.map((a) => (a.kind === 'env' ? [a.setting.key, a.why.code] : a.kind))).toEqual([
            // In the registry's order: Drafts & history comes after Database reads.
            ['database.readTimeoutMs', 'invalid_env'], ['drafts.idleCloseDays', 'env_out_of_range'],
        ])
    })

    it('puts the most important first: failing, waiting, signals, staged, fixes, then ignored deployment values', () => {
        const all = values({
            'reads.mode': { declared: 'beside', effective: 'in_place', status: 'adjusted', why: [why('builds_off')] },
            'drafts.defaultVisibility': { declared: 'private', effective: 'public', status: 'adjusted', why: [why('derived_from_levels')] },
        })
        const items = needsAttention({ ...NOTHING, summary: SUMMARY, signals: SIGNAL_COUNTS, values: all, staged: 2, problems: 0 })
        expect(kinds(items)).toEqual(['failing', 'waiting', 'signal', 'signal', 'staged', 'fix', 'fix', 'env'])
        expect(items.filter((a) => a.kind === 'fix').map((a) => (a.kind === 'fix' ? a.setting.key : ''))).toEqual(['reads.mode', 'drafts.defaultVisibility'])
        expect(new Set(items.map((a) => a.id)).size).toBe(items.length)
    })
})
