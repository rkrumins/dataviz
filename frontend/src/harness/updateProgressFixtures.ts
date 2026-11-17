/**
 * Updates in flight as the server reports them (`progress` on the watermark, sync status and a
 * graph's health), for the update-progress harness and its tests: one per state a reader can meet.
 */
import type { GraphUpdateProgress } from '@/services/versioningApiService'

const ago = (secs: number) => new Date(Date.now() - secs * 1000).toISOString()

/** An update 63% through its rows, with about 4 min left; `over` changes any of it. */
export function progressOf(over: Partial<GraphUpdateProgress> = {}): GraphUpdateProgress {
    return {
        phase: 'updating', done: 6_300, total: 10_000, unit: 'rows', ratePerSec: 25, etaSecs: 240,
        startedAt: ago(180), updatedAt: ago(1), targetSeq: 42, targetVersion: 42, ...over,
    }
}

const UNCOUNTED = { done: null, total: null, ratePerSec: null, etaSecs: null } as const

/** Every state, by name: what the harness draws and its screenshots are named after. */
export const PROGRESS_STATES: Record<string, { title: string; progress: GraphUpdateProgress }> = {
    updating: { title: 'Updating, with time left', progress: progressOf() },
    young: { title: 'Updating, its rate too young for a time', progress: progressOf({ done: 900, ratePerSec: null, etaSecs: null, startedAt: ago(6) }) },
    starting: { title: 'Updating, no rows landed yet', progress: progressOf({ done: 0, ratePerSec: null, etaSecs: null, startedAt: ago(2) }) },
    finishing: { title: 'Every row written, finishing up', progress: progressOf({ done: 10_000, etaSecs: null }) },
    phaseOnly: { title: 'Updating, rows not counted yet', progress: progressOf(UNCOUNTED) },
    seeding: { title: 'A first copy', progress: progressOf({ phase: 'seeding', done: 412_000, total: 1_250_000, ratePerSec: 3_150, etaSecs: 266 }) },
    loading: { title: 'Loading back into memory', progress: progressOf({ phase: 'loading', done: 88_000, total: 640_000, ratePerSec: 2_400, etaSecs: 4_100 }) },
    copying: { title: 'Built beside: a copy (no rows to count)', progress: progressOf({ phase: 'building', ...UNCOUNTED, startedAt: ago(95) }) },
    building: { title: 'Built beside: seeded from the database', progress: progressOf({ phase: 'building', done: 51_000, total: 120_000, ratePerSec: 410, etaSecs: 168, startedAt: ago(140) }) },
    switching: { title: 'Built beside: catching up before the switch', progress: progressOf({ phase: 'switching', done: 3_100, total: 4_000, ratePerSec: 20, etaSecs: 45, startedAt: ago(400) }) },
}
