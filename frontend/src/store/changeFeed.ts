/**
 * changeFeed — one subscription in place of nine idle polls.
 *
 * Nine always-mounted surfaces each ran their own timer against their
 * own endpoint, and every one of them was asking a question whose
 * answer is almost always no. This store asks that question once, for
 * all of them, and only wakes a surface when its answer changed.
 *
 * A surface registers what it cares about and how to refresh itself:
 *
 *     useChangeTopic(TOPICS.announcements, () => fetchActive())
 *
 * and stops owning a timer. The refresh function is the one it already
 * had — nothing about *what* it fetches changes, only *when*.
 *
 * ## The ordering invariant
 *
 * Read the version FIRST, then the data, then record the version:
 *
 *     v = manifest[topic]        // 1
 *     await refresh()            // 2
 *     applied[topic] = v         // 3
 *
 * The natural implementation does this backwards — refresh, then record
 * whatever the manifest says now — and that permanently loses any change
 * committed while the refresh was in flight: the client stores a version
 * it never actually fetched, sees no mismatch on the next poll, and
 * never asks again. Nothing errors, nothing logs, and the data is just
 * quietly wrong until the next unrelated change to the same topic.
 *
 * ## Comparing versions
 *
 * With `!==`, never `>`. Counters can go backwards — they carry a TTL so
 * Redis can evict them under memory pressure, and a missing counter
 * reads as 0. A client holding 4000 that only refreshed on `new > applied`
 * would never refresh again.
 */
import { useEffect, useRef } from 'react'
import { fetchChangeManifest, type ChangeVersions } from '@/services/changesService'
import { POLLING_INTERVALS, withJitter } from '@/config/polling'
import { onAppVisible } from '@/lib/appVisibility'

/**
 * Topic names. These are a wire contract with `backend/app/changes/topics.py`
 * — the per-user ones are keyed on user id server-side, but a client
 * never constructs those: the manifest only ever contains topics this
 * session is entitled to, so the client matches on the prefix it is
 * given rather than composing a name it might not be allowed to ask for.
 */
export const TOPICS = {
  announcements: 'announcements',
  features: 'features',
  providerHealth: 'providers:health',
  providerStatus: 'providers:status',
} as const

/** Prefixes for the per-user topics, whose suffix is the caller's id. */
const USER_TOPIC_PREFIXES = {
  permissions: 'perms:',
  notifications: 'notif:',
  inviteActivity: 'invite:',
} as const

export type UserTopic = keyof typeof USER_TOPIC_PREFIXES

interface Subscription {
  /** Either an exact topic name or a per-user prefix to match. */
  match: (topic: string) => boolean
  refresh: () => void | Promise<void>
  /**
   * Version this subscriber has actually fetched. `null` means "not
   * seeded yet" — the first manifest seeds it WITHOUT refreshing,
   * because the surface fetches on mount under its own steam and a
   * refresh here would just duplicate that.
   */
  applied: Map<string, number>
  minIntervalMs: number
  lastFiredAt: number
  /** Guards against a slow refresh overlapping its own next trigger. */
  inFlight: boolean
}

/**
 * Floor between refreshes of one subscriber. Provider state is the
 * reason this exists: it is bumped on transition, but a genuinely
 * flapping provider would otherwise turn every client's idle poll into
 * an idle refetch — strictly worse than the 60s poll it replaced.
 */
const DEFAULT_MIN_INTERVAL_MS = 5_000

const subscriptions = new Set<Subscription>()

/** Last manifest the server gave us. */
let versions: ChangeVersions = {}
/** True once a manifest has been read at least once. */
let seeded = false

function matchingTopics(sub: Subscription): string[] {
  return Object.keys(versions).filter(sub.match)
}

async function fire(sub: Subscription, targets: string[]): Promise<void> {
  // Capture the versions BEFORE refreshing. See the ordering invariant
  // in the module docstring — recording them afterwards would drop any
  // change committed while the refresh was in flight.
  const observed = new Map(targets.map((t) => [t, versions[t] ?? 0]))

  sub.inFlight = true
  sub.lastFiredAt = Date.now()
  try {
    await sub.refresh()
    // Only on success. A failed refresh leaves `applied` alone so the
    // next tick retries rather than recording data it never got.
    for (const [topic, version] of observed) sub.applied.set(topic, version)
  } catch {
    // The surface owns its own error reporting; the feed's job is to
    // keep asking.
  } finally {
    sub.inFlight = false
  }
}

/** Compare the latest manifest against what each subscriber holds. */
function reconcile(): void {
  const now = Date.now()
  for (const sub of subscriptions) {
    if (sub.inFlight) continue

    const topics = matchingTopics(sub)
    if (topics.length === 0) continue

    const unseeded = topics.filter((t) => !sub.applied.has(t))
    if (unseeded.length > 0) {
      // Seed without refreshing: the surface fetched on mount, and the
      // version we are seeding from was read before that fetch, so it
      // cannot be newer than what the surface holds.
      for (const topic of unseeded) sub.applied.set(topic, versions[topic] ?? 0)
      continue
    }

    const moved = topics.filter((t) => (versions[t] ?? 0) !== sub.applied.get(t))
    if (moved.length === 0) continue
    if (now - sub.lastFiredAt < sub.minIntervalMs) continue

    void fire(sub, moved)
  }
}

/**
 * Bumped whenever the stream pushes something. Used to discard a manifest
 * response that was already in flight when a push landed — see
 * `pollChangeFeed`.
 */
let pushGeneration = 0

/**
 * Read the manifest and wake whatever moved.
 *
 * Exported so any transport can drive it: the poll timer, a stream
 * opening, a `resync` frame, a tab regaining focus.
 *
 * A response that raced a push is discarded rather than applied. The
 * manifest is authoritative in general — it is what lets a counter go
 * *backwards* after a Redis eviction — but a read that started before a
 * bump and returned after it holds a value that is simply older than
 * what the stream just delivered. Applying it would roll the version
 * back to what the subscriber has already satisfied, and the push would
 * be silently lost until the next unrelated poll.
 */
export async function pollChangeFeed(): Promise<void> {
  const generationAtStart = pushGeneration
  const next = await fetchChangeManifest()
  if (pushGeneration !== generationAtStart) return
  versions = next
  seeded = true
  reconcile()
}

/** Latest known version map. Diagnostics and tests. */
export function currentVersions(): ChangeVersions {
  return { ...versions }
}

/** True once a manifest has been read. */
export function isSeeded(): boolean {
  return seeded
}

function subscribe(
  match: (topic: string) => boolean,
  refresh: () => void | Promise<void>,
  minIntervalMs: number,
): () => void {
  const sub: Subscription = {
    match,
    refresh,
    applied: new Map(),
    minIntervalMs,
    lastFiredAt: 0,
    inFlight: false,
  }
  subscriptions.add(sub)
  // Seed immediately against whatever we already know, so a surface
  // mounting mid-session does not treat the current version as a change.
  if (seeded) reconcile()
  return () => {
    subscriptions.delete(sub)
  }
}

/** Refresh when `topic` moves. `refresh` is the surface's existing fetch. */
export function useChangeTopic(
  topic: string,
  refresh: () => void | Promise<void>,
  options?: { minIntervalMs?: number; enabled?: boolean },
): void {
  // Held in a ref so an inline arrow does not re-subscribe every render,
  // and assigned in an effect rather than during render — writing a ref
  // mid-render is what React's rules-of-hooks lint is objecting to, and
  // it misbehaves under concurrent rendering.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })
  const { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, enabled = true } = options ?? {}

  useEffect(() => {
    if (!enabled) return
    return subscribe(
      (t) => t === topic,
      () => refreshRef.current(),
      minIntervalMs,
    )
  }, [topic, minIntervalMs, enabled])
}

/**
 * Refresh when one of the caller's own per-user topics moves.
 *
 * Matched by prefix rather than by composing `notif:${userId}`, because
 * the client has no business naming a topic: the manifest contains only
 * what this session may hear, so a prefix match cannot reach anyone
 * else's.
 */
export function useUserChangeTopic(
  kind: UserTopic,
  refresh: () => void | Promise<void>,
  options?: { minIntervalMs?: number; enabled?: boolean },
): void {
  // Held in a ref so an inline arrow does not re-subscribe every render,
  // and assigned in an effect rather than during render — writing a ref
  // mid-render is what React's rules-of-hooks lint is objecting to, and
  // it misbehaves under concurrent rendering.
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })
  const { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, enabled = true } = options ?? {}

  useEffect(() => {
    if (!enabled) return
    const prefix = USER_TOPIC_PREFIXES[kind]
    return subscribe(
      (t) => t.startsWith(prefix),
      () => refreshRef.current(),
      minIntervalMs,
    )
  }, [kind, minIntervalMs, enabled])
}

/** Subscribe outside React (module-scoped stores). Returns teardown. */
export function subscribeToTopic(
  topic: string,
  refresh: () => void | Promise<void>,
  options?: { minIntervalMs?: number },
): () => void {
  return subscribe(
    (t) => t === topic,
    refresh,
    options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
  )
}

/** `subscribeToTopic` for a per-user topic. Returns teardown. */
export function subscribeToUserTopic(
  kind: UserTopic,
  refresh: () => void | Promise<void>,
  options?: { minIntervalMs?: number },
): () => void {
  const prefix = USER_TOPIC_PREFIXES[kind]
  return subscribe(
    (t) => t.startsWith(prefix),
    refresh,
    options?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
  )
}

// ── Transport ─────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null
let transportEpoch = 0

/**
 * Apply a batch of `{topic: version}` pushed by the stream.
 *
 * The stream carries the new version with the notification, so a delta
 * is actionable on its own — no follow-up manifest read just to discover
 * what the version became.
 */
function applyPushedVersions(pushed: ChangeVersions): void {
  pushGeneration += 1
  versions = { ...versions, ...pushed }
  seeded = true
  reconcile()
}

/** Full jitter: `random(0, min(cap, base * 2^attempt))`. */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
  return Math.random() * ceiling
}

/**
 * Hold a stream, reconnecting as needed. Returns a teardown.
 *
 * Three things here are not optional:
 *
 *  * **`close()` in `onerror`.** `EventSource` retries on its own, so a
 *    handler that only records state leaves the browser's retry running
 *    *alongside* ours and the connection count doubles per failure. The
 *    job-progress hook nearby does exactly that; it gets away with it
 *    only because its streams are short-lived and few.
 *  * **Full jitter, not base-plus-jitter.** When a replica dies its
 *    clients all reconnect at once, and only full jitter actually
 *    decorrelates them.
 *  * **Reconcile on every open.** The stream is allowed to lose things;
 *    the manifest is what makes that safe.
 */
function connectStream(myEpoch: number): () => void {
  let source: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let closed = false

  const open = () => {
    if (closed || myEpoch !== transportEpoch) return
    const es = new EventSource('/api/v1/changes/stream', { withCredentials: true })
    source = es

    es.onopen = () => {
      attempt = 0
      // Whatever happened while we were not listening shows up here as a
      // version mismatch.
      void pollChangeFeed().catch(() => {})
    }

    es.addEventListener('changed', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data)
        if (payload?.topics) applyPushedVersions(payload.topics)
      } catch {
        // A frame we cannot parse is a reason to reconcile, not to fail.
        void pollChangeFeed().catch(() => {})
      }
    })

    es.addEventListener('resync', () => {
      void pollChangeFeed().catch(() => {})
    })

    // The server closes on a schedule so every stream's authorization
    // stays fresh — it authenticates once at open and cannot re-read the
    // cookie afterwards. Reconnecting picks up whatever the keepalive
    // has since rotated.
    es.addEventListener('reauth', () => {
      es.close()
      if (closed || myEpoch !== transportEpoch) return
      retryTimer = setTimeout(open, backoffDelay(0))
    })

    es.onerror = () => {
      // Close before scheduling: the browser's own retry would otherwise
      // run in parallel with ours.
      es.close()
      if (closed || myEpoch !== transportEpoch) return
      retryTimer = setTimeout(open, backoffDelay(attempt++))
    }
  }

  open()

  return () => {
    closed = true
    if (retryTimer) clearTimeout(retryTimer)
    source?.close()
    source = null
  }
}

// ── Cross-tab consolidation ───────────────────────────────────────────
//
// Everything above is per-tab, and tabs are the multiplier that made the
// original problem as large as it was: nine pollers with no cross-tab
// coordination meant N tabs cost N times as much. The stream removes the
// request cost but not the connection cost — five tabs is five held
// connections, and at fleet scale that is thousands of them doing the
// same work.
//
// So one tab does the work and tells the others. The two primitives this
// needs are both already in the codebase and are used the same way here:
//
//  * **Web Locks** for the election. `fetchWithTimeout` uses
//    `navigator.locks` to keep concurrent tabs from racing a token
//    refresh. A lock is held for as long as its callback's promise is
//    pending, and — the property that matters — it is released
//    automatically when the holding tab goes away, crash included. That
//    is failover with no heartbeat, no lease, and no stale-leader
//    detection to get wrong.
//  * **BroadcastChannel** for the fan-out, extending the bus
//    `permissionChangeBus` already runs rather than standing up a second.

const LEADER_LOCK = 'nx-change-feed-leader'
const BROADCAST_CHANNEL = 'nx-change-feed'

let channel: BroadcastChannel | null = null

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  if (channel === null) channel = new BroadcastChannel(BROADCAST_CHANNEL)
  return channel
}

/** Leader → followers. BroadcastChannel does not echo to the sender. */
function broadcastVersions(next: ChangeVersions): void {
  try {
    openChannel()?.postMessage({ versions: next })
  } catch {
    // A closed or unavailable channel just means the other tabs fall
    // back to their own reconciliation floor.
  }
}

/**
 * Do the actual work of the feed: hold a stream and a reconciliation
 * poll, and tell the other tabs whatever we learn.
 */
function startLeaderWork(myEpoch: number, useStream: boolean): () => void {
  const stopStream = useStream ? connectStream(myEpoch) : () => {}

  const publish = async () => {
    await pollChangeFeed()
    broadcastVersions(versions)
  }

  const tick = async () => {
    if (myEpoch !== transportEpoch) return
    if (typeof document === 'undefined' || !document.hidden) {
      try {
        await publish()
      } catch {
        // A failed manifest read is not worth reporting: surfaces keep
        // what they have and the next tick tries again. The server
        // answers 503 here when its registry is unreachable, which is
        // deliberately not the same as "nothing changed".
      }
    }
    if (myEpoch !== transportEpoch) return
    pollTimer = setTimeout(tick, withJitter(POLLING_INTERVALS.changeManifest))
  }

  void tick()
  const unsubscribeVisible = onAppVisible(() => {
    if (myEpoch !== transportEpoch) return
    void publish().catch(() => {})
  })

  return () => {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    unsubscribeVisible()
    stopStream()
  }
}

/**
 * Contend for leadership; do the work if we win, listen if we do not.
 *
 * Without Web Locks — jsdom, and a few older browsers — every tab leads.
 * That is the pre-consolidation behaviour, which is correct and merely
 * unconsolidated, so it is the right thing to degrade to.
 */
function startWithLeaderElection(myEpoch: number, useStream: boolean): () => void {
  let stopWork: (() => void) | null = null
  let releaseLock: (() => void) | null = null
  let abandoned = false

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) {
    return startLeaderWork(myEpoch, useStream)
  }

  // Followers apply what the leader learns. A follower opens no stream
  // and runs no timer, so its steady-state cost is zero.
  const onMessage = (ev: MessageEvent) => {
    if (myEpoch !== transportEpoch) return
    const next = ev.data?.versions
    if (next && typeof next === 'object') applyPushedVersions(next)
  }
  openChannel()?.addEventListener('message', onMessage)

  // One read on startup regardless of role: a tab opened mid-session
  // holds nothing, and waiting for the leader's next broadcast would
  // leave it blank until something happened to change.
  void pollChangeFeed().catch(() => {})

  // Resolves when we acquire the lock, which for a follower is when the
  // current leader's tab goes away — that is the whole failover story.
  void locks
    .request(LEADER_LOCK, () =>
      new Promise<void>((resolve) => {
        if (abandoned || myEpoch !== transportEpoch) {
          resolve()
          return
        }
        releaseLock = resolve
        stopWork = startLeaderWork(myEpoch, useStream)
      }),
    )
    .catch(() => {
      // A lock manager that rejects (private-mode quirks, a released
      // context) must not leave the tab with no feed at all.
      if (!abandoned && myEpoch === transportEpoch) {
        stopWork = startLeaderWork(myEpoch, useStream)
      }
    })

  return () => {
    abandoned = true
    openChannel()?.removeEventListener('message', onMessage)
    stopWork?.()
    stopWork = null
    // Releasing hands leadership to whichever tab is next in the queue.
    releaseLock?.()
    releaseLock = null
  }
}

/**
 * Start reconciling. Returns a teardown.
 *
 * One tab per browser does the work; the rest listen. Within that tab,
 * two transports run together, and that is deliberate rather than
 * redundant:
 *
 *  * **A stream**, which is what makes an idle tab cost nothing at all.
 *  * **A slow manifest poll**, which is what makes the stream safe to be
 *    lossy. It is the reconciliation floor — it catches a bump lost to a
 *    Redis blip, a gap across a reconnect, a stream refused because a
 *    process was full. Without it every one of those would be a surface
 *    silently stuck on stale data.
 *
 * The poll stays at the cadence the *slowest* of the nine original polls
 * ran at, so even fully degraded — no stream, no leader election — this
 * is one request per minute for the whole app rather than nine.
 */
export function startChangeFeed(options?: { stream?: boolean }): () => void {
  const myEpoch = ++transportEpoch
  const useStream = options?.stream ?? typeof EventSource !== 'undefined'
  const stopWork = startWithLeaderElection(myEpoch, useStream)

  return () => {
    transportEpoch += 1
    stopWork()
  }
}

/** Test-only: drop all state. */
export function __resetChangeFeedForTests(): void {
  subscriptions.clear()
  versions = {}
  seeded = false
  pushGeneration = 0
  try {
    channel?.close()
  } catch {
    // Already closed.
  }
  channel = null
  transportEpoch += 1
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}
