/**
 * ServedPlacements — where a view the server places draws each entity, asked of
 * `POST /view-placements` and kept for the canvas (see ./types.ts for the contract).
 *
 * Asks made within one tick are merged into one request, deduped against what is answered
 * and what is on its way, and sent in sorted batches — 2,000 URNs, or 500 with their nodes —
 * two at a time, `now` asks ahead of `background` ones. Answers go into ONE map, changed in
 * place: `version` counts the changes, so a reader re-reads on a number, never a copy.
 *
 * Every answer carries the view's stamp (epoch, digest, data version). The first fixes it; an
 * answer with another means the view's members or data moved, so what was answered before is
 * dropped (that answer kept), and an answer read before the move is asked again.
 *
 * A failure is read by what it says: 422/403/404/409 (and 400) — this view can't be placed
 * here, so nothing more is asked and callers place as they always have; a busy or slow server
 * (429, 503, a timeout, a dropped connection, no status at all) is asked again with a growing
 * pause, five more times; a 500 twice more; then the URNs are `failed` until `retryFailed()`.
 * A request this service stopped itself (every asker gone, or a reset) leaves its URNs unknown.
 *
 * Plain TypeScript, no React: ./ServedPlacementContext.tsx gives the canvas one.
 */
import { withFeedLayer } from '@/lib/canvasNodeMapper'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { httpStatusOf, patientDelayMs } from '@/services/graphRequestFailure'
import { VIEW_PLACEMENT_NODES_MAX, VIEW_PLACEMENTS_MAX, type ViewPlacementsAnswer } from '@/types/membership'
import type { FeedNode } from '@/types/searchView'

import type { LoadProgress, LoadResult, Placed, Priority, ServedPlacementsApi, UrnState } from './types'

/** Asks within this long of the first are sent together. */
export const ASK_TICK_MS = 16
/** Requests in flight at once. */
export const LANES = 2
/** More attempts for a busy or slow server, and for a 500. */
export const BUSY_RETRIES = 5
export const SERVER_ERROR_RETRIES = 2

/** The server can't place for this view, or not for this reader: nothing more is asked. */
const NOT_SERVED = new Set([400, 403, 404, 409, 422])
/** Busy, slow or briefly away: asked again. */
const BUSY = new Set([408, 429, 502, 503, 504])

type Kind = 'place' | 'nodes'

interface Batch {
  kind: Kind
  urns: string[]
  priority: Priority
  /** Failed attempts so far. */
  failures: number
  /** While in flight. */
  controller: AbortController | null
  /** Stopped by this service (every asker gone, or a reset): its URNs are unknown again. */
  dropped: boolean
  /** Waiting to be asked again: wakes early when stopped. */
  wake: (() => void) | null
}

interface Asker {
  urns: string[]
  remaining: number
  priority: Priority
  settled: boolean
  /** Asked for nodes (`load`). */
  nodes: boolean
  resolve: () => void
  reject: (err: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
  // `load` only.
  result?: LoadResult
  total?: number
  onProgress?: (p: LoadProgress) => void
  onNodes?: (nodes: LoadResult['nodes']) => void
}

export interface ServedPlacementsOptions {
  viewId: string
  provider: Pick<GraphDataProvider, 'viewPlacements'>
  /** What the answers were read for (view, members, data, revision): a different one in `reset` asks again. */
  resetKey?: string
}

const abortError = () => new DOMException('The ask was stopped', 'AbortError')

/** A failure no status explains: a timeout, a dropped connection, a body that didn't parse. */
const isBusy = (status: number | null) => status === null || BUSY.has(status)

export class ServedPlacements implements ServedPlacementsApi {
  readonly viewId: string
  private readonly provider: Pick<GraphDataProvider, 'viewPlacements'>
  private resetKey: string | undefined

  /** What each answered URN is drawn as — ONE map, changed in place. */
  private readonly entries = new Map<string, Placed>()
  private readonly failedUrns = new Set<string>()
  /** Asked this tick, not yet in a batch. */
  private readonly tick: Record<Kind, Map<string, Priority>> = { place: new Map(), nodes: new Map() }
  /** In a batch — queued or in flight. */
  private readonly inBatch: Record<Kind, Map<string, Batch>> = { place: new Map(), nodes: new Map() }
  private readonly queues: Record<Priority, Batch[]> = { now: [], background: [] }
  private readonly inFlight = new Set<Batch>()
  private readonly askers: Record<Kind, Map<string, Set<Asker>>> = { place: new Map(), nodes: new Map() }
  private tickTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<() => void>()

  /** The stamp the answers were read under, and how many times it moved. */
  private stamp: string | null = null
  private stampGen = 0
  private countsAt: { version: number; value: ReturnType<ServedPlacements['counts']> } | null = null

  version = 0
  /** Bumped each time what was answered is dropped (a reset, or the stamp moved): readers ask again. */
  generation = 0
  unavailable: null | { status: number; reason?: string } = null

  constructor(opts: ServedPlacementsOptions) {
    this.viewId = opts.viewId
    this.provider = opts.provider
    this.resetKey = opts.resetKey
  }

  /** Every answered URN and where it is drawn — the same map across answers. */
  get placements(): ReadonlyMap<string, Placed> {
    return this.entries
  }

  get(urn: string): Placed | undefined {
    return this.entries.get(urn)
  }

  stateOf(urn: string): UrnState {
    if (this.entries.has(urn)) return 'placed'
    if (this.failedUrns.has(urn)) return 'failed'
    return this.isAsking(urn) ? 'asking' : 'unknown'
  }

  placeOf(urns: readonly string[], opts: { signal?: AbortSignal; priority?: Priority } = {}): Promise<ReadonlyMap<string, Placed | null>> {
    const unique = [...new Set(urns)]
    const answer = () => new Map(unique.map((u) => [u, this.entries.get(u) ?? null] as const))
    if (opts.signal?.aborted) return Promise.reject(abortError())
    if (this.unavailable) return Promise.resolve(answer())
    const priority = opts.priority ?? 'background'
    // Answered already, or couldn't be asked (until retryFailed): nothing to wait for.
    const wait = unique.filter((u) => !this.entries.has(u) && !this.failedUrns.has(u))
    if (wait.length === 0) return Promise.resolve(answer())
    return new Promise((resolve, reject) => {
      const asker: Asker = {
        urns: wait, remaining: wait.length, priority, settled: false, nodes: false,
        resolve: () => resolve(answer()), reject, signal: opts.signal,
      }
      for (const u of wait) {
        this.join('place', u, asker)
        // A nodes ask on its way answers where it is drawn too.
        if (!this.inBatch.place.has(u) && !this.tick.place.has(u) && !this.inBatch.nodes.has(u) && !this.tick.nodes.has(u)) {
          this.tick.place.set(u, priority)
        } else {
          this.promote(u, priority)
        }
      }
      this.watchAbort(asker)
      this.scheduleTick()
    })
  }

  load(
    urns: readonly string[],
    opts: { signal?: AbortSignal; priority?: Priority; onProgress?: (p: LoadProgress) => void; onNodes?: (nodes: LoadResult['nodes']) => void } = {},
  ): Promise<LoadResult> {
    const unique = [...new Set(urns)]
    const result: LoadResult = { nodes: [], outside: [], failed: [] }
    if (opts.signal?.aborted) return Promise.reject(abortError())
    if (this.unavailable) return Promise.resolve({ ...result, failed: unique })
    const priority = opts.priority ?? 'background'
    const wait: string[] = []
    for (const u of unique) {
      // Drawn nowhere in this view: no node to bring.
      if (this.entries.get(u)?.layerId === null) result.outside.push(u)
      else wait.push(u)
    }
    if (wait.length === 0) return Promise.resolve(result)
    return new Promise((resolve, reject) => {
      const asker: Asker = {
        urns: wait, remaining: wait.length, priority, settled: false, nodes: true,
        resolve: () => resolve(result), reject, signal: opts.signal,
        result, total: unique.length, onProgress: opts.onProgress, onNodes: opts.onNodes,
      }
      for (const u of wait) {
        this.join('nodes', u, asker)
        if (!this.inBatch.nodes.has(u) && !this.tick.nodes.has(u)) this.tick.nodes.set(u, priority)
        else this.promote(u, priority)
      }
      this.watchAbort(asker)
      this.scheduleTick()
    })
  }

  counts(urns?: Iterable<string>): { placed: number; asking: number; failed: number; outside: number } {
    if (!urns && this.countsAt?.version === this.version) return { ...this.countsAt.value }
    const out = { placed: 0, asking: 0, failed: 0, outside: 0 }
    if (urns) {
      for (const u of new Set(urns)) {
        const placed = this.entries.get(u)
        if (placed) {
          if (placed.layerId === null) out.outside++
          else out.placed++
        } else if (this.failedUrns.has(u)) out.failed++
        else if (this.isAsking(u)) out.asking++
      }
      return out
    }
    this.entries.forEach((p) => { if (p.layerId === null) out.outside++; else out.placed++ })
    out.failed = this.failedUrns.size
    const asking = new Set<string>()
    for (const kind of ['place', 'nodes'] as const) {
      this.tick[kind].forEach((_, u) => asking.add(u))
      this.inBatch[kind].forEach((_, u) => asking.add(u))
    }
    asking.forEach((u) => { if (!this.entries.has(u)) out.asking++ })
    this.countsAt = { version: this.version, value: out }
    return { ...out }
  }

  /** Ask again for what couldn't be asked. */
  retryFailed(): void {
    if (this.failedUrns.size === 0 || this.unavailable) return
    const urns = [...this.failedUrns]
    this.failedUrns.clear()
    // Kept asking for whoever reads them (no one waits on this ask, and no one can stop it).
    const asker: Asker = {
      urns, remaining: urns.length, priority: 'now', settled: false, nodes: false,
      resolve: () => {}, reject: () => {},
    }
    for (const u of urns) {
      this.join('place', u, asker)
      if (!this.inBatch.place.has(u) && !this.tick.place.has(u)) this.tick.place.set(u, 'now')
    }
    this.scheduleTick()
    this.changed()
  }

  /** Ask afresh: the view, its members or its data changed. With the key the answers were
   *  read for, nothing changes; the first key given only names what they are read for. */
  reset(resetKey?: string): void {
    if (resetKey !== undefined) {
      if (this.resetKey === undefined) { this.resetKey = resetKey; return }
      if (resetKey === this.resetKey) return
      this.resetKey = resetKey
    }
    this.stopRequests()
    this.entries.clear()
    this.failedUrns.clear()
    this.unavailable = null
    this.stamp = null
    this.stampGen++
    this.generation++
    // Whoever still waits is asked for again.
    for (const kind of ['place', 'nodes'] as const) {
      this.askers[kind].forEach((set, u) => { if (set.size > 0) this.tick[kind].set(u, topPriority(set)) })
    }
    this.scheduleTick()
    this.changed()
  }

  /** Stop every request and ask; whoever waits is told it was stopped. Answers are kept, and
   *  the service can be asked again (a canvas unmounting, or React's check of its effects). */
  dispose(): void {
    this.stopRequests()
    const waiting = new Set<Asker>()
    for (const kind of ['place', 'nodes'] as const) {
      this.askers[kind].forEach((set) => set.forEach((a) => waiting.add(a)))
      this.askers[kind].clear()
    }
    waiting.forEach((a) => this.settle(a, abortError()))
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  // ── Asking ────────────────────────────────────────────────────────────────

  private isAsking(urn: string): boolean {
    return this.tick.place.has(urn) || this.tick.nodes.has(urn)
      || this.inBatch.place.has(urn) || this.inBatch.nodes.has(urn)
  }

  private join(kind: Kind, urn: string, asker: Asker): void {
    let set = this.askers[kind].get(urn)
    if (!set) this.askers[kind].set(urn, (set = new Set()))
    set.add(asker)
  }

  /** A `now` ask for a URN already asked in the background: its batch goes ahead. */
  private promote(urn: string, priority: Priority): void {
    if (priority !== 'now') return
    for (const kind of ['place', 'nodes'] as const) {
      if (this.tick[kind].has(urn)) this.tick[kind].set(urn, 'now')
      const batch = this.inBatch[kind].get(urn)
      if (batch && batch.priority === 'background' && !this.inFlight.has(batch)) {
        const i = this.queues.background.indexOf(batch)
        if (i >= 0) {
          this.queues.background.splice(i, 1)
          batch.priority = 'now'
          this.queues.now.push(batch)
        }
      }
    }
  }

  private watchAbort(asker: Asker): void {
    if (!asker.signal) return
    asker.onAbort = () => this.abandon(asker)
    asker.signal.addEventListener('abort', asker.onAbort, { once: true })
  }

  /** The asker stopped: what no one else waits on is asked no more. */
  private abandon(asker: Asker): void {
    if (asker.settled) return
    const kind: Kind = asker.nodes ? 'nodes' : 'place'
    const loose: string[] = []
    for (const u of asker.urns) {
      const set = this.askers[kind].get(u)
      if (!set) continue
      set.delete(asker)
      if (set.size === 0) {
        this.askers[kind].delete(u)
        if (!this.askers.place.has(u) && !this.askers.nodes.has(u)) loose.push(u)
      }
    }
    this.settle(asker, abortError())
    const touched = new Set<Batch>()
    for (const u of loose) {
      for (const k of ['place', 'nodes'] as const) {
        this.tick[k].delete(u)
        const batch = this.inBatch[k].get(u)
        if (batch) touched.add(batch)
      }
    }
    touched.forEach((batch) => {
      const wanted = batch.urns.filter((u) => this.askers.place.has(u) || this.askers.nodes.has(u))
      if (wanted.length > 0 && this.inFlight.has(batch)) return   // still wanted by someone
      if (wanted.length > 0) {
        // Queued: send only what is still wanted.
        for (const u of batch.urns) if (!wanted.includes(u)) this.inBatch[batch.kind].delete(u)
        batch.urns = wanted
        return
      }
      this.drop(batch)
    })
    this.pump()
    this.changed()
  }

  private scheduleTick(): void {
    if (this.tickTimer !== null) return
    this.tickTimer = setTimeout(() => this.flush(), ASK_TICK_MS)
  }

  /** This tick's asks, in sorted batches: each kind's `now` asks first. */
  private flush(): void {
    this.tickTimer = null
    for (const kind of ['nodes', 'place'] as const) {
      const asked = this.tick[kind]
      if (asked.size === 0) continue
      const byPriority: Record<Priority, string[]> = { now: [], background: [] }
      asked.forEach((p, u) => { byPriority[p].push(u) })
      asked.clear()
      const size = kind === 'nodes' ? VIEW_PLACEMENT_NODES_MAX : VIEW_PLACEMENTS_MAX
      for (const priority of ['now', 'background'] as const) {
        const urns = byPriority[priority].sort()
        for (let i = 0; i < urns.length; i += size) {
          const batch: Batch = {
            kind, urns: urns.slice(i, i + size), priority, failures: 0, controller: null, dropped: false, wake: null,
          }
          for (const u of batch.urns) this.inBatch[kind].set(u, batch)
          this.queues[priority].push(batch)
        }
      }
    }
    this.pump()
    this.changed()
  }

  private pump(): void {
    while (this.inFlight.size < LANES) {
      const batch = this.queues.now.shift() ?? this.queues.background.shift()
      if (!batch) return
      this.inFlight.add(batch)
      void this.send(batch).finally(() => {
        this.inFlight.delete(batch)
        this.pump()
      })
    }
  }

  private async send(batch: Batch): Promise<void> {
    while (!batch.dropped) {
      const controller = new AbortController()
      batch.controller = controller
      const sentUnder = this.stampGen
      let answer: ViewPlacementsAnswer
      try {
        answer = await this.provider.viewPlacements!(this.viewId, batch.urns, {
          signal: controller.signal, ...(batch.kind === 'nodes' ? { nodes: true } : {}),
        })
      } catch (err) {
        batch.controller = null
        if (batch.dropped || controller.signal.aborted) return   // stopped here: unknown again
        const status = httpStatusOf(err)
        if (status !== null && NOT_SERVED.has(status)) {
          this.markUnavailable(status, reasonOf(err))
          return
        }
        const budget = status === 500 ? SERVER_ERROR_RETRIES : isBusy(status) ? BUSY_RETRIES : 0
        if (batch.failures >= budget) {
          this.fail(batch)
          return
        }
        const pause = patientDelayMs(err, batch.failures)
        batch.failures += 1
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { batch.wake = null; resolve() }, pause)
          batch.wake = () => { clearTimeout(timer); batch.wake = null; resolve() }
        })
        continue
      }
      batch.controller = null
      if (batch.dropped) return
      this.answered(batch, answer, sentUnder)
      return
    }
  }

  // ── Answers ───────────────────────────────────────────────────────────────

  private answered(batch: Batch, answer: ViewPlacementsAnswer, sentUnder: number): void {
    const stamp = `${answer.epoch ?? ''}|${answer.digest ?? ''}|${answer.dataVersion ?? ''}`
    if (this.stamp === null) {
      this.stamp = stamp
    } else if (stamp !== this.stamp) {
      if (sentUnder !== this.stampGen) {
        // Read before the view last moved: asked again, under what it is now.
        this.requeue(batch)
        return
      }
      // The view's members or data moved: what was answered before is stale.
      this.stamp = stamp
      this.stampGen++
      this.generation++
      this.entries.clear()
    }
    const forAskers = new Map<Asker, LoadResult>()
    for (const u of batch.urns) {
      const p = answer.placements[u]
      const placed: Placed = p
        ? { layerId: p.layerId ?? null, source: p.source, ...(p.inLayer != null ? { inLayer: p.inLayer } : {}) }
        : { layerId: null, source: 'none' }
      this.entries.set(u, placed)
      this.failedUrns.delete(u)
      if (this.inBatch[batch.kind].get(u) === batch) this.inBatch[batch.kind].delete(u)
      this.settleUrn('place', u)
      if (batch.kind === 'nodes') {
        const node = answer.nodes?.[u] as FeedNode | undefined
        this.settleUrn('nodes', u, (asker) => {
          const got = forAskers.get(asker) ?? { nodes: [], outside: [], failed: [] }
          forAskers.set(asker, got)
          if (placed.layerId === null) got.outside.push(u)
          else if (node) got.nodes.push({ node: withFeedLayer(node, placed.layerId), layerId: placed.layerId })
          // Placed in a layer, but its node didn't come: it can't be drawn from here.
          else got.failed.push(u)
        })
      }
    }
    this.deliver(forAskers)
    this.changed()
  }

  private fail(batch: Batch): void {
    const forAskers = new Map<Asker, LoadResult>()
    for (const u of batch.urns) {
      if (this.inBatch[batch.kind].get(u) === batch) this.inBatch[batch.kind].delete(u)
      if (!this.entries.has(u)) this.failedUrns.add(u)
      this.settleUrn('place', u)
      if (batch.kind === 'nodes') {
        this.settleUrn('nodes', u, (asker) => {
          const got = forAskers.get(asker) ?? { nodes: [], outside: [], failed: [] }
          forAskers.set(asker, got)
          got.failed.push(u)
        })
      }
    }
    this.deliver(forAskers)
    this.changed()
  }

  private markUnavailable(status: number, reason?: string): void {
    this.unavailable = { status, ...(reason ? { reason } : {}) }
    this.stopRequests()
    // Everyone waiting has their answer: nothing more will come.
    for (const kind of ['place', 'nodes'] as const) {
      const waiting = this.askers[kind]
      const urns = [...waiting.keys()]
      const forAskers = new Map<Asker, LoadResult>()
      for (const u of urns) {
        this.settleUrn(kind, u, (asker) => {
          const got = forAskers.get(asker) ?? { nodes: [], outside: [], failed: [] }
          forAskers.set(asker, got)
          got.failed.push(u)
        })
      }
      this.deliver(forAskers)
    }
    this.changed()
  }

  /** Each asker's share of a batch, and whether that was the last it waited on. */
  private deliver(forAskers: Map<Asker, LoadResult>): void {
    forAskers.forEach((got, asker) => {
      const result = asker.result
      if (!result) return
      result.nodes.push(...got.nodes)
      result.outside.push(...got.outside)
      result.failed.push(...got.failed)
      if (got.nodes.length > 0) asker.onNodes?.(got.nodes)
      asker.onProgress?.({
        done: result.nodes.length + result.outside.length + result.failed.length,
        total: asker.total ?? asker.urns.length,
        placed: result.nodes.length, outside: result.outside.length, failed: result.failed.length,
      })
    })
    forAskers.forEach((_, asker) => { if (asker.remaining === 0) this.settle(asker) })
  }

  /** One URN answered (or given up on) for everyone asking it of `kind`. */
  private settleUrn(kind: Kind, urn: string, each?: (asker: Asker) => void): void {
    const set = this.askers[kind].get(urn)
    if (!set) return
    this.askers[kind].delete(urn)
    set.forEach((asker) => {
      asker.remaining -= 1
      each?.(asker)
      // A `load` asker settles once its share is delivered (see deliver).
      if (asker.remaining === 0 && !asker.result) this.settle(asker)
    })
  }

  private settle(asker: Asker, err?: unknown): void {
    if (asker.settled) return
    asker.settled = true
    if (asker.signal && asker.onAbort) asker.signal.removeEventListener('abort', asker.onAbort)
    if (err) asker.reject(err)
    else asker.resolve()
  }

  /** Asked again from its start, ahead of what waits. */
  private requeue(batch: Batch): void {
    const again: Batch = { ...batch, failures: 0, controller: null, dropped: false, wake: null }
    for (const u of again.urns) if (this.inBatch[batch.kind].get(u) === batch) this.inBatch[batch.kind].set(u, again)
    this.queues[again.priority].unshift(again)
  }

  /** Stopped here: its URNs are unknown again. */
  private drop(batch: Batch): void {
    batch.dropped = true
    batch.controller?.abort()
    batch.wake?.()
    // Its lane is free at once, whenever the stopped request settles.
    this.inFlight.delete(batch)
    for (const u of batch.urns) if (this.inBatch[batch.kind].get(u) === batch) this.inBatch[batch.kind].delete(u)
    for (const priority of ['now', 'background'] as const) {
      const i = this.queues[priority].indexOf(batch)
      if (i >= 0) this.queues[priority].splice(i, 1)
    }
  }

  private stopRequests(): void {
    if (this.tickTimer !== null) clearTimeout(this.tickTimer)
    this.tickTimer = null
    this.tick.place.clear()
    this.tick.nodes.clear()
    const batches = new Set<Batch>([...this.inFlight, ...this.queues.now, ...this.queues.background])
    batches.forEach((b) => this.drop(b))
    this.inBatch.place.clear()
    this.inBatch.nodes.clear()
  }

  /** What readers see moved: an answer, a failure, an ask sent, a reset. */
  private changed(): void {
    this.version++
    this.listeners.forEach((fn) => fn())
  }
}

function topPriority(askers: Set<Asker>): Priority {
  for (const a of askers) if (a.priority === 'now') return 'now'
  return 'background'
}

/** The refusal's code (`not_served_view`, `base_missing`, …), where the server said one. */
function reasonOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const reason = (err as { detail?: { reason?: unknown } } | null)?.detail?.reason
  return typeof reason === 'string' ? reason : undefined
}
