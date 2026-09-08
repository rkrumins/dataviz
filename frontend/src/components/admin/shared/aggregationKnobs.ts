/**
 * The one catalogue of aggregation tuning knobs — labels, bounds, help and
 * grouping — shared by the per-job Advanced tuning form and the fleet-wide
 * Defaults dialog, so a knob is described once and the two editors can never
 * disagree about what a field means.
 *
 * Placeholders are NOT hard-coded here: the server reports every knob's live
 * env default (``envTuningDefaults`` on the settings response), and
 * ``knobPlaceholder`` reads it, falling back to the shipped default only when
 * the server has not said. ``resolveKnob`` names where a value came from.
 *
 * The capacity arithmetic at the bottom is the pipeline's own rule
 * (``providers/shard_capacity.py``), so a what-if in the UI moves the same
 * way the next rebuild will decide.
 */
import type {
    AggregationTuning, CapacityLimits, EnvTuningDefaults, ShardCapacity,
} from '@/services/aggregationService'

export type TuningKnobKey =
    | 'scanRangeWidth' | 'maxPendingPairs' | 'applyChunk' | 'deleteChunk'
    | 'writePacingRatio' | 'extractConcurrency'
    | 'shardReservePct' | 'bytesPerEdge' | 'maxMaterializedEdges'

export type KnobGroup = 'capacity' | 'reading' | 'writing'

export interface TuningKnob {
    key: TuningKnobKey
    label: string
    /** The long-form explanation behind the info icon. */
    tip: string
    /** The one-line hint under the input, with the bounds. */
    help: string
    min: number
    max: number
    step?: number
    float?: boolean
    group: KnobGroup
    /** Shipped default, used only when the server has not reported the env. */
    fallback: number
    /** What an EMPTY field means when it is not "the env default" — the
     *  ceiling, for one, where empty means "the shard governs". */
    emptyMeans?: string
    /** Knobs the per-job form does not offer (fleet-wide only). */
    fleetOnly?: true
}

export const KNOB_GROUPS: Record<KnobGroup, { title: string; blurb: string }> = {
    capacity: {
        title: 'Capacity',
        blurb: 'What the rebuild measures on the shard that owns a graph before it writes rollups, and the limits it applies to that reading.',
    },
    reading: {
        title: 'Reading the source',
        blurb: 'How hard the extract phase leans on the graph store, and how much the worker holds in memory before it flushes.',
    },
    writing: {
        title: 'Writing rollups',
        blurb: 'How the apply and delete passes pace themselves against live traffic.',
    },
}

export const TUNING_KNOBS: TuningKnob[] = [
    {
        key: 'shardReservePct',
        label: 'Shard memory reserve',
        tip: 'Before it writes, a rebuild reads used memory and maxmemory on the shard that owns the graph and stores new rollup edges only while they fit under this share of maxmemory. It is the headroom that stays free for live queries and every other graph on that shard — under noeviction, the write that fills a shard fails every graph’s writes on it.',
        help: 'Share of the shard’s maxmemory a rebuild must leave free (0-90%)',
        min: 0, max: 90, group: 'capacity', fallback: 20,
    },
    {
        key: 'bytesPerEdge',
        label: 'Bytes per rollup edge',
        tip: 'What one stored rollup edge is assumed to cost when the budget converts free memory into edges. Each successful rebuild measures the real figure for its graph and uses that next time; set this only to pin the estimate by hand, for every graph.',
        help: 'Planning figure until a rebuild has measured its graph (64-16,384 B)',
        min: 64, max: 16_384, group: 'capacity', fallback: 512,
    },
    {
        key: 'maxMaterializedEdges',
        label: 'Edge ceiling',
        tip: 'An OPTIONAL explicit cap on the total rollup edges a graph may store, layered over the measured shard budget. Leave it empty to let the shard govern; set it only to hold a graph below what its shard could take. When a shard cannot be measured (no maxmemory), this or the environment’s static cap is the rule that applies.',
        help: 'Explicit cap over the measured budget; empty lets the shard govern (10,000-500,000,000)',
        min: 10_000, max: 500_000_000, group: 'capacity', fallback: 25_000_000,
        emptyMeans: 'shard governs',
    },
    {
        key: 'scanRangeWidth',
        label: 'Scan range width',
        tip: 'Width of each edge-ID range the extract phase scans per query. The pipeline shrinks this automatically under pressure — this value is the ceiling.',
        help: 'Edges per scan range (10,000-5,000,000)',
        min: 10_000, max: 5_000_000, group: 'reading', fallback: 200_000,
    },
    {
        key: 'extractConcurrency',
        label: 'Extract concurrency',
        tip: 'Number of parallel extract scans. Higher values speed up the extract phase but put more read load on the provider.',
        help: 'Parallel scans (1-4)',
        min: 1, max: 4, group: 'reading', fallback: 1,
    },
    {
        key: 'maxPendingPairs',
        label: 'Memory cap — max pending pairs',
        tip: 'Maximum aggregated pairs held in worker memory before the pipeline flushes early. Lower values reduce worker RSS at the cost of more flush cycles. This bounds the WORKER, not the graph store.',
        help: 'Pairs held in memory (50,000-50,000,000)',
        min: 50_000, max: 50_000_000, group: 'reading', fallback: 50_000_000,
    },
    {
        key: 'writePacingRatio',
        label: 'Write pacing ratio',
        tip: 'Idle time inserted between write chunks, as a ratio of the previous chunk’s duration. Higher values leave more headroom for live queries but make the job slower; 0 disables pacing entirely.',
        help: 'Pause between writes (0-10)',
        min: 0, max: 10, step: 0.1, float: true, group: 'writing', fallback: 1.0,
    },
    {
        key: 'applyChunk',
        label: 'Apply chunk',
        tip: 'Rollup edges written per apply query. Larger chunks finish sooner; smaller ones checkpoint more often and yield to live traffic between writes.',
        help: 'Pairs written per apply chunk (1,000-200,000)',
        min: 1_000, max: 200_000, group: 'writing', fallback: 20_000, fleetOnly: true,
    },
    {
        key: 'deleteChunk',
        label: 'Delete chunk',
        tip: 'Stale rollup edges removed per delete query during the reconcile pass.',
        help: 'Stale edges deleted per query (100-50,000)',
        min: 100, max: 50_000, group: 'writing', fallback: 10_000, fleetOnly: true,
    },
]

export const KNOB_BY_KEY: Record<TuningKnobKey, TuningKnob> = Object.fromEntries(
    TUNING_KNOBS.map(k => [k.key, k]),
) as Record<TuningKnobKey, TuningKnob>

/** The env default the server reported for a knob, else the shipped one. */
export function envDefaultFor(knob: TuningKnob, env?: EnvTuningDefaults | null): number {
    const raw = env?.[knob.key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : knob.fallback
}

/** What an empty input shows: the meaning of empty, or the live default. */
export function knobPlaceholder(knob: TuningKnob, env?: EnvTuningDefaults | null): string {
    if (knob.emptyMeans) return knob.emptyMeans
    const v = envDefaultFor(knob, env)
    return knob.float ? String(v) : v.toLocaleString('en-US').replace(/,/g, '')
}

export type KnobSource = 'job' | 'global' | 'default' | 'none'

/**
 * The value a knob resolves to and where it came from, in the order the
 * server resolves it: the form's own value (a per-job override, or the
 * Defaults draft) → the stored global → the environment. A knob whose empty
 * state means "nothing" (the ceiling) resolves to ``none`` rather than the
 * shipped fallback.
 */
export function resolveKnob(
    knob: TuningKnob,
    formValue: number | null | undefined,
    storedGlobal?: AggregationTuning | null,
    env?: EnvTuningDefaults | null,
): { value: number | null; source: KnobSource } {
    if (typeof formValue === 'number' && Number.isFinite(formValue)) {
        return { value: formValue, source: 'job' }
    }
    const global = storedGlobal?.[knob.key]
    if (typeof global === 'number' && Number.isFinite(global)) {
        return { value: global, source: 'global' }
    }
    if (knob.emptyMeans) {
        const raw = env?.[knob.key]
        // The ceiling's env default exists (the static cap) but only governs
        // when the shard cannot be measured — so "empty" is still "none".
        return typeof raw === 'number' && knob.key !== 'maxMaterializedEdges'
            ? { value: raw, source: 'default' }
            : { value: null, source: 'none' }
    }
    return { value: envDefaultFor(knob, env), source: 'default' }
}

export function clampKnob(knob: TuningKnob, value: number): number {
    return Math.max(knob.min, Math.min(knob.max, value))
}

// ── Capacity arithmetic (the pipeline's rule, for what-ifs) ────────────

/** Bytes still free on a shard once the reserve is set aside. Null when the
 *  shard cannot be measured. */
export function freeAfterReserve(
    shard: Pick<ShardCapacity, 'used' | 'maxmemory' | 'measurable'>,
    reservePct: number,
): number | null {
    if (!shard.measurable || shard.maxmemory == null || shard.used == null || shard.maxmemory <= 0) return null
    const reserve = Math.floor(shard.maxmemory * Math.max(0, Math.min(90, reservePct)) / 100)
    return Math.max(0, shard.maxmemory - reserve - shard.used)
}

/** How many rollup edges fit in ``freeBytes`` at ``bytesPerEdge``. */
export function fitsEdges(freeBytes: number | null, bytesPerEdge: number): number | null {
    if (freeBytes == null || bytesPerEdge <= 0) return null
    return Math.floor(freeBytes / bytesPerEdge)
}

export type FitVerdict = {
    verdict: 'fits' | 'short' | 'unknown'
    growthEdges: number | null
    neededBytes: number | null
    freeBytes: number | null
    shortfallBytes: number | null
    blockedBy: 'shard' | 'ceiling' | null
}

/**
 * Would a FORCED full cube land, given a draft of the limits? Mirrors the
 * pipeline's verdict: growth over what the graph already holds, at bytes per
 * edge, against free-after-reserve widened by the estimate margin — and an
 * explicit ceiling on the total that the margin never widens.
 */
export function fullDetailVerdict(args: {
    shard: Pick<ShardCapacity, 'used' | 'maxmemory' | 'measurable'>
    limits: Pick<CapacityLimits, 'estimateMarginPct'>
    edgeCount: number
    estimateEdges: number | null | undefined
    bytesPerEdge: number
    reservePct: number
    ceiling: number | null
}): FitVerdict {
    const { shard, limits, edgeCount, estimateEdges, bytesPerEdge, reservePct, ceiling } = args
    if (estimateEdges == null) {
        return { verdict: 'unknown', growthEdges: null, neededBytes: null, freeBytes: null, shortfallBytes: null, blockedBy: null }
    }
    const growth = Math.max(0, estimateEdges - edgeCount)
    const needed = growth * bytesPerEdge
    const free = freeAfterReserve(shard, reservePct)
    if (ceiling != null && estimateEdges > ceiling) {
        return { verdict: 'short', growthEdges: growth, neededBytes: needed, freeBytes: free, shortfallBytes: null, blockedBy: 'ceiling' }
    }
    if (free == null) {
        return { verdict: 'unknown', growthEdges: growth, neededBytes: needed, freeBytes: null, shortfallBytes: null, blockedBy: null }
    }
    const allowance = Math.floor(free * (100 + Math.max(0, limits.estimateMarginPct)) / 100)
    if (needed > allowance) {
        return { verdict: 'short', growthEdges: growth, neededBytes: needed, freeBytes: free, shortfallBytes: needed - free, blockedBy: 'shard' }
    }
    return { verdict: 'fits', growthEdges: growth, neededBytes: needed, freeBytes: free, shortfallBytes: 0, blockedBy: null }
}

/** Compact edge counts for prose: 1.2M, 850K, 42. */
export function compactEdges(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(n)) return '—'
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
    return String(Math.round(n))
}

/** Bytes for prose: 22.0 GB, 512 MB, 900 B. */
export function compactBytes(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes)) return '—'
    const gb = bytes / 2 ** 30
    if (gb >= 1) return `${gb.toFixed(1)} GB`
    const mb = bytes / 2 ** 20
    if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
    const kb = bytes / 1024
    if (kb >= 1) return `${kb.toFixed(0)} KB`
    return `${Math.round(bytes)} B`
}
