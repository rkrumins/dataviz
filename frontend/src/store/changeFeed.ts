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
 * Read the manifest once and wake whatever moved.
 *
 * Exported so the transport can drive it: today a timer, and once the
 * stream lands, a reconnect.
 */
export async function pollChangeFeed(): Promise<void> {
  const next = await fetchChangeManifest()
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
 * Start reconciling. Returns a teardown.
 *
 * Today the transport is a single jittered poll of the manifest, paused
 * while the tab is hidden and kicked once on return. That is already the
 * whole point of this store — one request per interval for every surface
 * in the app, in place of nine — and it is the floor the streaming
 * transport will fall back to when it cannot hold a connection.
 *
 * The loop deliberately awaits before re-arming rather than using
 * `setInterval`: a slow or hung manifest request must not stack another
 * on top of it. Every timer this store replaced had to learn that the
 * hard way.
 */
export function startChangeFeed(): () => void {
  const myEpoch = ++transportEpoch

  const tick = async () => {
    if (myEpoch !== transportEpoch) return
    if (typeof document === 'undefined' || !document.hidden) {
      try {
        await pollChangeFeed()
      } catch {
        // A failed manifest read is not worth reporting: the surfaces
        // keep what they have, and the next tick tries again. The server
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
    void pollChangeFeed().catch(() => {})
  })

  return () => {
    transportEpoch += 1
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    unsubscribeVisible()
  }
}

/** Test-only: drop all state. */
export function __resetChangeFeedForTests(): void {
  subscriptions.clear()
  versions = {}
  seeded = false
  transportEpoch += 1
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}
