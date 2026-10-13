/**
 * The explorer's selection, kept in the URL.
 *
 * Every filter is a search param, so a view of the log is a link: an auditor
 * can send "every manual rebuild of Ledger last week" to whoever asked. The
 * params are prefixed `act_` because the explorer is also mounted inside the
 * workspace page, which owns `tab` and `ds` already.
 *
 * Derived from the URL on every render and never mirrored into state — the
 * pattern AnalyticsPage uses — so back/forward and a pasted link can never
 * disagree with what is on screen. Unknown values fall back to defaults.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import { RANGE_PRESETS } from '@/components/analytics/RangePicker'
import type { AnalyticsRangeSelection } from '@/services/analyticsService'
import {
    ACTIVITY_CATEGORIES,
    type ActivityCategory,
    type ActivityOutcome,
    type ActivityQuery,
    type PersonRole,
} from '@/services/activityService'

import { DEFAULT_LENS, LENSES, type Lens } from './activityMeta'

/** Thirty days: what the summary answers for by default. */
export const DEFAULT_ACTIVITY_DAYS = 30

export const ACTIVITY_PARAMS = {
    lens: 'act_lens',
    days: 'act_days',
    from: 'act_from',
    to: 'act_to',
    types: 'act_type',
    person: 'act_person',
    role: 'act_role',
    workspace: 'act_ws',
    dataSource: 'act_ds',
    targetType: 'act_ttype',
    targetId: 'act_tid',
    outcome: 'act_outcome',
    reason: 'act_reason',
    q: 'act_q',
    event: 'act_event',
} as const

type ParamName = keyof typeof ACTIVITY_PARAMS
export type ActivityParamPatch = Partial<Record<ParamName, string | null>>

/** The filters a person sets beyond the lens and the range. */
const FILTER_PARAMS: ParamName[] = [
    'types', 'person', 'role', 'workspace', 'dataSource', 'targetType',
    'targetId', 'outcome', 'reason', 'q',
]

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ROLES: PersonRole[] = ['any', 'actor', 'subject']
const OUTCOMES: ActivityOutcome[] = ['success', 'failure', 'denied']

function parseRange(params: URLSearchParams): AnalyticsRangeSelection {
    const from = params.get(ACTIVITY_PARAMS.from)
    const to = params.get(ACTIVITY_PARAMS.to)
    if (from && to && DATE.test(from) && DATE.test(to)) return { kind: 'custom', from, to }
    const days = Number(params.get(ACTIVITY_PARAMS.days))
    return RANGE_PRESETS.some((p) => p.days === days)
        ? { kind: 'preset', days }
        : { kind: 'preset', days: DEFAULT_ACTIVITY_DAYS }
}

export interface ActivityParams {
    lens: Lens
    range: AnalyticsRangeSelection
    /** What the server is asked for: the lens, the range and every filter. */
    query: ActivityQuery
    eventTypes: string[]
    person: string
    personRole: PersonRole
    workspaceId: string | null
    dataSourceId: string | null
    targetType: string | null
    targetId: string | null
    outcome: ActivityOutcome | null
    /** `given` — only events with a reason; `missing` — only without. */
    reason: 'given' | 'missing' | null
    q: string
    /** The event open in the drawer. */
    eventId: string | null
    /** Filters set beyond the lens and the range. */
    activeFilterCount: number
    patch: (patch: ActivityParamPatch) => void
    setLens: (id: string) => void
    setRange: (range: AnalyticsRangeSelection) => void
    openEvent: (id: string) => void
    closeEvent: () => void
    clearFilters: () => void
}

export function useActivityParams(): ActivityParams {
    const [searchParams, setSearchParams] = useSearchParams()

    const patch = useCallback((changes: ActivityParamPatch) => {
        setSearchParams((current) => {
            const next = new URLSearchParams(current)
            for (const [name, value] of Object.entries(changes) as [ParamName, string | null][]) {
                const key = ACTIVITY_PARAMS[name]
                if (value === null || value === '') next.delete(key)
                else next.set(key, value)
            }
            return next
        }, { replace: true })
    }, [setSearchParams])

    const derived = useMemo(() => {
        const get = (name: ParamName) => searchParams.get(ACTIVITY_PARAMS[name])
        const lens = LENSES.find((l) => l.id === get('lens')) ?? LENSES.find((l) => l.id === DEFAULT_LENS)!
        const range = parseRange(searchParams)
        const eventTypes = (get('types') ?? '').split(',').map((t) => t.trim()).filter(Boolean)
        const person = get('person')?.trim() ?? ''
        const role = get('role') as PersonRole | null
        const personRole: PersonRole = role && ROLES.includes(role) ? role : 'any'
        const outcomeRaw = get('outcome') as ActivityOutcome | null
        const outcome = outcomeRaw && OUTCOMES.includes(outcomeRaw) ? outcomeRaw : null
        const reasonRaw = get('reason')
        const reason: 'given' | 'missing' | null =
            reasonRaw === 'given' || reasonRaw === 'missing' ? reasonRaw : null
        const q = get('q')?.trim() ?? ''

        const query: ActivityQuery = {
            range,
            categories: lens.categories.filter((c): c is ActivityCategory =>
                (ACTIVITY_CATEGORIES as readonly string[]).includes(c)),
            eventTypes: eventTypes.length ? eventTypes : undefined,
            person: person || undefined,
            personRole,
            workspaceId: get('workspace') || undefined,
            dataSourceId: get('dataSource') || undefined,
            targetType: get('targetType') || undefined,
            targetId: get('targetId') || undefined,
            outcome: outcome ?? undefined,
            hasReason: reason === null ? undefined : reason === 'given',
            includeNoise: lens.includeNoise || outcome === 'denied' || undefined,
            q: q || undefined,
        }
        return {
            lens, range, query, eventTypes, person, personRole,
            workspaceId: get('workspace'),
            dataSourceId: get('dataSource'),
            targetType: get('targetType'),
            targetId: get('targetId'),
            outcome, reason, q,
            eventId: get('event'),
            activeFilterCount: FILTER_PARAMS.filter((name) => name !== 'role' && !!get(name)).length,
        }
    }, [searchParams])

    // An action belongs to a lens: one picked under "Access" means nothing
    // under "Operations", so a new lens starts from any action.
    const setLens = useCallback((id: string) => {
        patch({ lens: id === DEFAULT_LENS ? null : id, types: null })
    }, [patch])

    const setRange = useCallback((range: AnalyticsRangeSelection) => {
        patch(range.kind === 'custom'
            ? { days: null, from: range.from, to: range.to }
            : { days: range.days === DEFAULT_ACTIVITY_DAYS ? null : String(range.days), from: null, to: null })
    }, [patch])

    const openEvent = useCallback((id: string) => patch({ event: id }), [patch])
    const closeEvent = useCallback(() => patch({ event: null }), [patch])
    const clearFilters = useCallback(() => {
        patch(Object.fromEntries(FILTER_PARAMS.map((name) => [name, null])) as ActivityParamPatch)
    }, [patch])

    return { ...derived, patch, setLens, setRange, openEvent, closeEvent, clearFilters }
}
