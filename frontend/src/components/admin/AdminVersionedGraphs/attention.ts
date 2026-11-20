/**
 * What needs attention on the platform, from what the Overview already reads and nothing else:
 *
 *   failing    graphs whose last update failed (the fleet's figures)
 *   waiting    graphs waiting for room on their node (the fleet's figures)
 *   signal     a problem whose counts reached their `warnAt` in the last 24 hours (the signals)
 *   staged     changes staged on the platform and not saved
 *   fix        a value the server adjusted, whose why carries the fix (the platform's values)
 *   env        a value whose deployment value the server ignored: not valid, or out of range
 *
 * Each item is one of those facts as the server counted or resolved it: nothing is estimated, and
 * nothing is asked for here. The Overview words each and gives it its one action.
 *
 * In order of importance: what readers feel now (failing, then waiting graphs), what keeps
 * happening (the signal furthest past its mark first), the person's own changes not yet saved,
 * then the platform's values (adjusted, then ignored deployment values), each in the registry's
 * order.
 */
import { normalize, type ResolvedSetting, type ResolvedValues, type Setting, type Signal, type SignalCount, type WhyFix, type WhyItem } from '@/components/settings'
import type { GraphsSummary } from '@/services/settingsService'

/** A signal's `warnAt` is set for 24 hours: a count over another window isn't held to it. */
export const WARN_WINDOW = '24h'

/** The why codes that say the deployment's environment value was ignored. */
const ENV_CODES = new Set(['invalid_env', 'env_out_of_range'])

/** A signal at or past its mark, with its count. */
export interface Happened {
    signal: Signal
    count: number
}

export type AttentionItem =
    | { kind: 'failing'; id: string; count: number }
    | { kind: 'waiting'; id: string; count: number }
    /** `symptom` as the signal words it; the finder opens at it. */
    | { kind: 'signal'; id: string; symptom: string; happened: Happened[] }
    /** `problems` of the staged changes need a fix before they can be reviewed. */
    | { kind: 'staged'; id: string; count: number; problems: number }
    | { kind: 'fix'; id: string; setting: Setting; resolved: ResolvedSetting; why: WhyItem; fix: WhyFix }
    | { kind: 'env'; id: string; setting: Setting; resolved: ResolvedSetting; why: WhyItem }

export interface AttentionInput {
    /** The fleet's figures; absent while they load or when they couldn't be read. */
    summary: GraphsSummary | undefined
    /** How often each signal happened; absent when the server doesn't count them, or couldn't. */
    signals: SignalCount[] | undefined
    /** The registry's signals, which join a count to its mark and the problem it answers. */
    definitions: Signal[]
    /** The registry's settings, in its order. */
    settings: Setting[]
    /** The platform's values; absent while they load or when they couldn't be read. */
    values: ResolvedValues | undefined
    /** Changes staged on the platform, and how many of them need a fix first. */
    staged: number
    problems: number
}

export function needsAttention({ summary, signals, definitions, settings, values, staged, problems }: AttentionInput): AttentionItem[] {
    const out: AttentionItem[] = []
    if (summary?.failing) out.push({ kind: 'failing', id: 'failing', count: summary.failing })
    if (summary?.waitingForRoom) out.push({ kind: 'waiting', id: 'waiting', count: summary.waitingForRoom })

    // Each problem once, its signals together, as the finder groups them.
    const known = new Map(definitions.map((signal, at) => [signal.id, { signal, at }]))
    const byProblem = new Map<string, { symptom: string; happened: Happened[]; past: number; at: number }>()
    for (const c of signals ?? []) {
        const found = known.get(c.id)
        if (!found) continue
        const { signal, at } = found
        if (signal.warnAt === null || c.window !== WARN_WINDOW || c.count === 0 || c.count < signal.warnAt) continue
        const key = normalize(signal.symptom)
        const p = byProblem.get(key) ?? { symptom: signal.symptom, happened: [], past: 0, at }
        p.happened.push({ signal, count: c.count })
        // How far past its mark: 38 against 30 is further than 1 against 1.
        p.past = Math.max(p.past, c.count / Math.max(signal.warnAt, 1))
        p.at = Math.min(p.at, at)
        byProblem.set(key, p)
    }
    const ranked = [...byProblem.entries()].sort(([, a], [, b]) => b.past - a.past || a.at - b.at)
    for (const [key, p] of ranked) out.push({ kind: 'signal', id: `signal:${key}`, symptom: p.symptom, happened: p.happened })

    if (staged > 0) out.push({ kind: 'staged', id: 'staged', count: staged, problems })

    if (values) {
        const env: AttentionItem[] = []
        for (const s of settings) {
            const r = values[s.key]
            if (!r) continue
            const fixable = r.status === 'adjusted' ? r.why.find((w) => w.fix) : undefined
            if (fixable?.fix) out.push({ kind: 'fix', id: `fix:${s.key}`, setting: s, resolved: r, why: fixable, fix: fixable.fix })
            const ignored = r.why.find((w) => ENV_CODES.has(w.code))
            if (ignored) env.push({ kind: 'env', id: `env:${s.key}`, setting: s, resolved: r, why: ignored })
        }
        out.push(...env)
    }
    return out
}
