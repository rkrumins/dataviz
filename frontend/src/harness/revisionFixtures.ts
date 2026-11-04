/**
 * The revision harness's backend: Published's history, its calendar, what opening a revision takes,
 * and the change list of any two revisions compared — answered in memory for the versioning routes
 * the revision viewer reads (`revisionFetch`). Deterministic, so a screenshot is the same each time.
 */

export const HARNESS_WS = 'ws-harness'
export const HARNESS_DS = 'ds-harness'
export const HARNESS_GRAPH = 'g-harness'
export const HARNESS_VIEW = 'view-harness'
export const HEAD = 214
/** Revisions before this are too far back to draw (more than the rewind ceiling since). */
export const TOO_FAR_BELOW = 160

const PEOPLE = ['u_ana', 'u_ben', 'u_chen', 'u_dee']
export const USER_NAMES: Record<string, string> = {
  u_ana: 'Ana Lee', u_ben: 'Ben Okafor', u_chen: 'Chen Wu', u_dee: 'Dee Marsh',
}
const MESSAGES = [
  'Quarter close: finance marts', 'Import from DataHub', 'Rename orders columns', 'Retire legacy CRM tables',
  'Add churn dashboard lineage', 'Merge review: billing domain', 'Sync from the warehouse', 'Fix customer keys',
  'New marketing pipeline', 'Split events by region',
]
const KINDS = ['squash_publish', 'import', 'squash_publish', 'sync', 'squash_publish', 'revert']

/** Published's revisions, newest first: HEAD down to 155, spread over Aug–Nov 2026. */
export const COMMITS = Array.from({ length: HEAD - 154 }, (_, i) => {
  const seq = HEAD - i
  // About a day and a half apart, ending on 4 Nov 2026 at 17:42 UTC.
  const at = new Date(Date.UTC(2026, 10, 4, 17, 42) - i * 31 * 3600_000)
  const kind = KINDS[seq % KINDS.length]
  return {
    commit_id: `cmt_${seq}`,
    commit_seq: seq,
    kind,
    message: MESSAGES[seq % MESSAGES.length],
    actor: PEOPLE[seq % PEOPLE.length],
    contributors: kind === 'squash_publish' ? [PEOPLE[seq % 4], PEOPLE[(seq + 1) % 4]] : null,
    source_commit_count: kind === 'squash_publish' ? 2 + (seq % 5) : null,
    stats: { create: (seq * 7) % 40, update: (seq * 3) % 25, delete: seq % 6 },
    created_at: at.toISOString(),
  }
})

/** The calendar: every month of 2026 with how many revisions it saw, Oct and Nov busiest. */
export const MONTHS = {
  headSeq: HEAD,
  tz: 'UTC',
  months: [
    [1, 3], [2, 6], [3, 4], [4, 9], [5, 7], [6, 2], [7, 11], [8, 15], [9, 19], [10, 28], [11, 6],
  ].map(([m, count], i, all) => {
    const before = all.slice(0, i).reduce((n, [, c]) => n + c, 0)
    const firstSeq = HEAD - all.reduce((n, [, c]) => n + c, 0) + before + 1
    const lastSeq = firstSeq + count - 1
    const daysIn = new Date(2026, m, 0).getDate()
    const days: Array<{ day: string; count: number; firstSeq: number; lastSeq: number }> = []
    let left = count
    let seq = firstSeq
    for (let d = 1; d <= daysIn && left > 0; d += 1 + ((d * 7 + m) % 3)) {
      const n = Math.min(left, 1 + ((d + m) % 3))
      days.push({ day: `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, count: n, firstSeq: seq, lastSeq: seq + n - 1 })
      seq += n
      left -= n
    }
    return {
      month: `2026-${String(m).padStart(2, '0')}`, count, firstSeq, lastSeq,
      lastAt: new Date(Date.UTC(2026, m - 1, daysIn, 18)).toISOString(), days,
    }
  }),
}

export function revisionInfo(seq: number) {
  const commit = COMMITS.find((c) => c.commit_seq === seq) ?? {
    commit_id: `cmt_${seq}`, commit_seq: seq, kind: 'squash_publish', message: MESSAGES[seq % MESSAGES.length],
    actor: PEOPLE[seq % 4], created_at: new Date(Date.UTC(2026, 5, 1 + (seq % 28), 10)).toISOString(), stats: {},
  }
  const changed = seq < TOO_FAR_BELOW ? 100_001 : (HEAD - seq) * 380
  return {
    commit, userNames: USER_NAMES, headSeq: HEAD, changedSince: changed, limit: 100_000,
    openable: seq < TOO_FAR_BELOW ? false : seq <= HEAD, reason: seq < TOO_FAR_BELOW ? 'too_far' : null,
  }
}

const TYPES: Array<[string, 'node' | 'edge' | 'structure', number, number, number]> = [
  ['Table', 'node', 0.36, 0.22, 0.02], ['Column', 'node', 0.30, 0.18, 0.04], ['Dashboard', 'node', 0.05, 0.03, 0],
  ['Pipeline', 'node', 0.04, 0.02, 0.01], ['Domain', 'node', 0.004, 0.006, 0], ['Metric', 'node', 0.02, 0.01, 0],
  ['Report', 'node', 0.01, 0.01, 0.002], ['Glossary term', 'node', 0.006, 0.002, 0], ['Notebook', 'node', 0.003, 0.001, 0],
  ['FLOWS_TO', 'edge', 0.12, 0.02, 0.01], ['CONTAINS', 'structure', 0.09, 0, 0.005],
]

/** What changed after `from`, up to and including `to`: about 380 entities a revision. */
export function summaryFor(from: number, to: number) {
  const span = Math.max(1, to - from)
  const total = span * 380
  const byType = TYPES.map(([type, kind, a, m, r]) => ({
    kind, type, added: Math.round(total * a), modified: Math.round(total * m), removed: Math.round(total * r),
  }))
  const sum = (k: 'added' | 'modified' | 'removed', kind?: string) =>
    byType.filter((t) => !kind || t.kind === kind).reduce((n, t) => n + t[k], 0)
  const counts = (kind?: string) => ({ added: sum('added', kind), modified: sum('modified', kind), removed: sum('removed', kind) })
  const fromCommit = revisionInfo(from).commit
  const toCommit = revisionInfo(to).commit
  return {
    origin: { fromSeq: from, toSeq: to }, counts: counts(), entityCounts: counts('node'), edgeCounts: counts('edge'),
    structureCounts: counts('structure'), impact: {}, byType,
    total: byType.reduce((n, t) => n + t.added + t.modified + t.removed, 0),
    listed: byType.reduce((n, t) => n + t.added + t.modified + t.removed, 0), approximate: false, tooLarge: null,
    window: {
      commitCount: span, contributors: PEOPLE.slice(0, Math.min(4, 1 + (span % 4))), contributorCount: Math.min(4, 1 + (span % 4)),
      firstAt: fromCommit.created_at, lastAt: toCommit.created_at,
      from: { seq: from, commitId: fromCommit.commit_id, kind: fromCommit.kind, message: fromCommit.message, actor: fromCommit.actor, createdAt: fromCommit.created_at },
      to: { seq: to, commitId: toCommit.commit_id, kind: toCommit.kind, message: toCommit.message, actor: toCommit.actor, createdAt: toCommit.created_at },
    },
    userNames: USER_NAMES,
  }
}

const NAMES = ['orders', 'customers', 'invoices', 'events', 'sessions', 'refunds', 'payments', 'accounts', 'leads', 'campaigns']

/** A page of the change list, in its order: by type, then name. */
export function entriesFor(from: number, to: number, kind: string, offset: number, limit: number) {
  const s = summaryFor(from, to)
  const types = s.byType.filter((t) => (t.kind === 'structure' ? 'structure' : t.kind) === kind)
  const rows: Array<Record<string, unknown>> = []
  for (const t of types) {
    for (const status of ['added', 'modified', 'removed'] as const) {
      for (let i = 0; i < Math.min(t[status], 40); i++) {
        const name = `${NAMES[i % NAMES.length]}_${String(i).padStart(2, '0')}`
        rows.push(kind === 'node'
          ? { entityId: `${t.type}:${name}:${status}`, kind: 'node', status, type: t.type, structural: false,
              displayName: name, qualifiedName: `analytics.${name}`, urn: `urn:${t.type}:${name}` }
          : { entityId: `${t.type}:${name}:${status}`, kind: 'edge', status, type: t.type, structural: kind === 'structure',
              sourceEntityId: `urn:${name}`, targetEntityId: `urn:${name}_v2`, sourceName: name, targetName: `${name}_v2` })
      }
    }
  }
  const page = rows.slice(offset, offset + limit)
  return { entries: page, total: rows.length, offset, limit, hasMore: offset + page.length < rows.length, tooLarge: null }
}

/** Answers the versioning routes the revision viewer reads; anything else is a 404. */
export function revisionFetch(): typeof fetch {
  return async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const p = url.pathname
    const q = url.searchParams
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (/\/graphs\/[^/]+\/commits$/.test(p)) {
      const before = q.get('before') ? Number(q.get('before')) : Infinity
      const limit = Number(q.get('limit') ?? 50)
      const older = COMMITS.filter((c) => c.commit_seq < before)
      const page = older.slice(0, limit)
      const hasMore = older.length > page.length
      return json({ commits: page, userNames: USER_NAMES, hasMore, nextBefore: hasMore ? page.at(-1)!.commit_seq : null })
    }
    if (p.endsWith('/history/months')) return json(MONTHS)
    const rev = p.match(/\/revisions\/(\d+)$/)
    if (rev) return json(revisionInfo(Number(rev[1])))
    const from = Number(q.get('fromSeq'))
    const to = Number(q.get('toSeq'))
    if (p.endsWith('/diff/summary')) return json(summaryFor(from, to))
    if (p.endsWith('/diff/entries')) {
      return json(entriesFor(from, to, q.get('kind') ?? 'node', Number(q.get('offset') ?? 0), Number(q.get('limit') ?? 100)))
    }
    if (p.endsWith('/diff/index')) return json({ origin: { fromSeq: from, toSeq: to }, entries: [], total: 0, truncated: false })
    return json({ detail: 'not in the revision harness' }, 404)
  }
}
