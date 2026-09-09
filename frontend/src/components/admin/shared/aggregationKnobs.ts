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
    AggregationCapacityResponse, AggregationTuning, CapacityLimits, EnvTuningDefaults, ShardCapacity,
} from '@/services/aggregationService'

export type TuningKnobKey =
    | 'scanRangeWidth' | 'maxPendingPairs' | 'applyChunk' | 'deleteChunk'
    | 'writePacingRatio' | 'extractConcurrency' | 'scanShrinkFloor'
    | 'shardReservePct' | 'bytesPerEdge' | 'maxMaterializedEdges'
    | 'scanTimeoutS' | 'writeTimeoutS' | 'stallTimeoutSecs' | 'maxWallSecs'
    | 'flushMemPct' | 'maxCubeEdges' | 'estimateMarginPct'
    | 'replicaAckMin' | 'replicaAckTimeoutMs'

export type KnobGroup = 'capacity' | 'reading' | 'writing' | 'timeouts'

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
    timeouts: {
        title: 'Time limits',
        blurb: 'How long one query may take, and how long a job may go without progress or run in total. A slow store is retried and narrowed, never abandoned, within these.',
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
        key: 'maxCubeEdges',
        label: 'Auto’s cube ceiling',
        tip: 'The largest full-detail estimate Auto stores in full; above it Auto keeps the depth-diagonal and derives finer granularities on demand. Deliberately separate from the write budget: a cube the shard would refuse is never picked regardless, and raising the budget must not silently turn Auto into Always full detail. Keep it below any edge ceiling.',
        help: 'Largest full-detail estimate Auto stores (10,000-50,000,000 edges)',
        min: 10_000, max: 50_000_000, group: 'capacity', fallback: 8_000_000, fleetOnly: true,
    },
    {
        key: 'estimateMarginPct',
        label: 'Estimate margin',
        tip: 'Slack on the upper-bound estimate a forced Full detail run is checked with before anything is computed, so a loose estimate does not refuse a cube the exact count after compute would pass. The exact check still stands behind it.',
        help: 'Slack on the pre-compute estimate (0-100%)',
        min: 0, max: 100, group: 'capacity', fallback: 25, fleetOnly: true,
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
        key: 'scanShrinkFloor',
        label: 'Scan floor',
        tip: 'The narrowest scan slice the pressure ladder descends to when the graph store refuses a query for size or time. At 1 the rebuild reads one row at a time before it concludes that a single row is larger than the store’s per-query ceiling — the only failure it cannot narrow its way out of. A higher floor fails sooner with less certainty.',
        help: 'Narrowest scan slice before a single row is declared too large (1-5,000,000 rows)',
        min: 1, max: 5_000_000, group: 'reading', fallback: 1,
    },
    {
        key: 'maxPendingPairs',
        label: 'Memory cap — max pending pairs',
        tip: 'Maximum aggregated pairs held in worker memory before the pipeline flushes early. Lower values reduce worker RSS at the cost of more flush cycles. This bounds the WORKER, not the graph store.',
        help: 'Pairs held in memory (50,000-50,000,000)',
        min: 50_000, max: 50_000_000, group: 'reading', fallback: 50_000_000,
    },
    {
        key: 'flushMemPct',
        label: 'Memory flush',
        tip: 'The memory-aware flush: when the rebuild worker’s memory use crosses this share of its container limit, the pipeline writes the pairs it holds to the graph early and frees them, however many there are — so a graph that produces more pairs than the worker can hold flushes instead of being OOM-killed. Needs both readings (RSS and the cgroup limit) and at least the minimum pairs set by the deployment; the pair cap above still applies.',
        help: 'Percent of the worker’s memory limit (30-90)',
        min: 30, max: 90, group: 'reading', fallback: 60, fleetOnly: true,
    },
    {
        key: 'writePacingRatio',
        label: 'Write pacing ratio',
        tip: 'Idle time inserted between write chunks, as a ratio of the previous chunk’s duration. Higher values leave more headroom for live queries but make the job slower; 0 disables pacing entirely.',
        help: 'Pause between writes (0-10)',
        min: 0, max: 10, step: 0.1, float: true, group: 'writing', fallback: 1.0,
    },
    {
        key: 'replicaAckMin',
        label: 'Replica acknowledgement',
        tip: 'How many replicas of the node a rebuild writes to must confirm each batch before the next one is sent. The graph store replicates a small write by having every replica RE-RUN it, on the replica’s main thread and with no timeout — so a rebuild that only watches the master can run its replicas into a full resync and a restarted node. Waiting makes the replicas’ real capacity the write rate. 0 waits for none (a store with no replicas, or one you deliberately let fall behind).',
        help: 'Replicas that must confirm each write (0-5)',
        min: 0, max: 5, group: 'writing', fallback: 1,
    },
    {
        key: 'replicaAckTimeoutMs',
        label: 'Replica ack timeout',
        tip: 'How long one acknowledgement wait may block before the rebuild holds, says the replicas are behind, and tries again. Not a failure: the run keeps its checkpoint and its heartbeat throughout, and its time limits stay the only bound.',
        help: 'Milliseconds per acknowledgement wait (500-60,000)',
        min: 500, max: 60_000, step: 500, group: 'writing', fallback: 5_000,
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
    {
        key: 'scanTimeoutS',
        label: 'Scan timeout',
        tip: 'How long one read scan may run before the store aborts it. A scan that times out is re-read in narrower slices, and at the narrowest slice retried with backoff before the run declares the store unreachable and resumes later from its checkpoint. Values above the store’s own TIMEOUT_MAX are capped by the store.',
        help: 'Seconds per read scan (5-600)',
        min: 5, max: 600, step: 1, float: true, group: 'timeouts', fallback: 30,
    },
    {
        key: 'writeTimeoutS',
        label: 'Write timeout',
        tip: 'How long one write or delete batch may run before the store aborts it. A batch that times out is re-issued as two halves, down to a single row. Values above the store’s TIMEOUT_MAX are capped by the store.',
        help: 'Seconds per write or delete batch (5-600)',
        min: 5, max: 600, step: 1, float: true, group: 'timeouts', fallback: 60,
    },
    {
        key: 'stallTimeoutSecs',
        label: 'Stall window',
        tip: 'How long a job may make NO forward progress before the watchdog kills it, for jobs that do not set their own (automatic rebuilds). The per-job Stall timeout in the re-trigger dialog wins over this. Narrowed scans and backoff retries heartbeat, so a slow rebuild is progress, not a stall.',
        help: 'Seconds without progress before a job is killed (60-604,800)',
        min: 60, max: 604_800, group: 'timeouts', fallback: 10_800, fleetOnly: true,
    },
    {
        key: 'maxWallSecs',
        label: 'Wall clock',
        tip: 'The longest a job may run in total, however much progress it makes — the safety net for a rebuild that never ends. Never lower than the job’s stall window. Can be raised on a running job from Job History.',
        help: 'Total run time allowed (3,600-604,800 s)',
        min: 3_600, max: 604_800, group: 'timeouts', fallback: 86_400,
    },
]

/**
 * The graph store's own per-query cap (TIMEOUT_MAX) bounds the two per-query
 * timeouts above it: a value past the cap is silently capped by the store.
 * The cap READ FROM THE NODE (``shardTimeoutMaxMs``, from the capacity sweep)
 * wins over the deployment's mirror (``env.serverTimeoutMaxMs``): the store's
 * cap can be raised at runtime from Infrastructure, and the mirror does not
 * follow. Returns the sentence to show under the input when a value is past
 * the cap, else null.
 */
export function serverCapNote(
    knob: TuningKnob,
    value: number | null | undefined,
    env?: EnvTuningDefaults | null,
    shardTimeoutMaxMs?: number | null,
): string | null {
    if (knob.key !== 'scanTimeoutS' && knob.key !== 'writeTimeoutS') return null
    const fromNode = typeof shardTimeoutMaxMs === 'number' && shardTimeoutMaxMs > 0
    const capMs = fromNode ? shardTimeoutMaxMs : env?.serverTimeoutMaxMs
    if (typeof capMs !== 'number' || capMs <= 0 || typeof value !== 'number') return null
    const capS = capMs / 1000
    if (value <= capS) return null
    return `Capped by the graph store at ${capS % 1 === 0 ? capS : capS.toFixed(1)} s (TIMEOUT_MAX, ${fromNode ? 'read from the node' : 'from the deployment'}) — an administrator can raise it under Admin → Graph store → Adjust limits.`
}

/** The lowest TIMEOUT_MAX read across the measured shards — the cap every
 *  per-query timeout is really bounded by — or null when none reported one. */
export function fleetTimeoutCapMs(capacity?: Pick<AggregationCapacityResponse, 'shards'> | null): number | null {
    const caps = (capacity?.shards ?? [])
        .map(s => s.timeoutMaxMs)
        .filter((v): v is number => typeof v === 'number' && v > 0)
    return caps.length ? Math.min(...caps) : null
}

/** Where an administrator adjusts a node's own limits. */
export function graphStoreLimitsPath(endpoint: string): string {
    // Admin → Graph store is where a node is looked at, so it is where its
    // limits are changed. Infrastructure still answers the same ``?limits=``
    // deep link, so anything bookmarked before this keeps working.
    return `/admin/graph-store?limits=${encodeURIComponent(endpoint)}`
}

const MIB = 2 ** 20
const GIB = 2 ** 30

/**
 * The deployment guide's container sizing rule, mirrored from the server
 * (``providers/shard_capacity.container_memory_needed``): 1.25 × maxmemory +
 * concurrent × 1.3 × QUERY_MEM_CAPACITY + overhead (256 MiB; 1 GiB from
 * 32 GiB). The 1.3 is the reply buffer the ceiling does not count;
 * ``concurrent`` is how many queries may hold the ceiling at once — at most
 * the node's THREAD_COUNT, since the ceiling is charged per thread.
 */
export function containerNeededBytes(maxmemory: number, concurrent: number, queryMemCapacity: number): number {
    const overhead = maxmemory >= 32 * GIB ? GIB : 256 * MIB
    return Math.floor(1.25 * maxmemory)
        + Math.max(1, Math.floor(concurrent)) * Math.floor(1.3 * queryMemCapacity)
        + overhead
}

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

/** The shard fields the free-memory rule reads: the reading, and what running
 *  rebuilds hold in the node's reservation ledger. */
export type ShardReading = Pick<ShardCapacity, 'used' | 'maxmemory' | 'measurable'> & Partial<Pick<ShardCapacity, 'reservedBytes'>>

/** Bytes still free on a shard once the reserve is set aside and what running
 *  rebuilds hold is taken off — the pipeline's own rule. Null when the shard
 *  cannot be measured. */
export function freeAfterReserve(shard: ShardReading, reservePct: number): number | null {
    if (!shard.measurable || shard.maxmemory == null || shard.used == null || shard.maxmemory <= 0) return null
    const reserve = Math.floor(shard.maxmemory * Math.max(0, Math.min(90, reservePct)) / 100)
    return Math.max(0, shard.maxmemory - reserve - shard.used - Math.max(0, shard.reservedBytes ?? 0))
}

/** "1.2 GB held by 2 running rebuilds" — what the node's reservation ledger
 *  holds right now; null when nothing is. */
export function heldByRebuilds(shard: Pick<ShardCapacity, 'reservedBytes' | 'reservedByJobs'>): string | null {
    const n = shard.reservedByJobs ?? 0
    if (n <= 0) return null
    return `${compactBytes(shard.reservedBytes)} held by ${n} running ${n === 1 ? 'rebuild' : 'rebuilds'}`
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
    shard: ShardReading
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
