/**
 * The provenance harness's backend: a published history where people and automation both change
 * the graph, answered in memory for the versioning routes History and the "behind Published" strip
 * read (`provenanceFetch`). Deterministic, so a screenshot is the same each time.
 *
 * - **Snowflake sync**, a service account, writes through its key "Nightly loader" every half hour.
 * - **Ana**'s own key "dbt CI" refreshes descriptions: a script acting as her.
 * - **The platform** re-syncs once.
 * - **Ben** publishes a draft Ana edited.
 */

export const HARNESS_WS = 'ws-harness'
export const HARNESS_DS = 'ds-harness'
export const HARNESS_GRAPH = 'g-harness'
export const HARNESS_VIEW = 'view-harness'
export const HEAD = 230

export const USER_NAMES: Record<string, string> = {
  u_ana: 'Ana Lee', u_ben: 'Ben Okafor', u_chen: 'Chen Wu', u_dee: 'Dee Marsh', svc_snowflake: 'Snowflake sync',
}
export const API_KEY_NAMES: Record<string, string> = { apk_nightly: 'Nightly loader', apk_dbt: 'dbt CI' }

type Commit = Record<string, unknown> & { commit_seq: number; automation: boolean }

const at = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 10, day, h, m)).toISOString()

const person = (seq: number, actor: string, message: string, created: string, stats: Record<string, number>,
  extra: Record<string, unknown> = {}): Commit => ({
  commit_id: `cmt_${seq}`, commit_seq: seq, kind: 'squash_publish', message, actor, actor_kind: 'human',
  api_key_id: null, correlation_id: null, automation: false, contributors: [actor], source_commit_count: 1,
  stats, created_at: created, ...extra,
})

const SNOWFLAKE = Array.from({ length: 12 }, (_, i): Commit => {
  const seq = 229 - i
  const creates = (seq * 7) % 30
  const updates = 40 + ((seq * 13) % 70)
  const deletes = seq % 4
  return {
    commit_id: `cmt_${seq}`, commit_seq: seq, kind: 'edit', message: `batch: ${creates + updates + deletes} commands`,
    actor: 'svc_snowflake', actor_kind: 'service', api_key_id: 'apk_nightly',
    correlation_id: `req_7f3a${seq}c1e`, automation: true, contributors: ['svc_snowflake'],
    stats: { create: creates, update: updates, delete: deletes },
    created_at: new Date(Date.UTC(2026, 10, 9, 15, 30) - i * 30 * 60_000).toISOString(),   // every half hour
  }
})

/** Published's log, newest first. */
export const COMMITS: Commit[] = [
  person(230, 'u_ben', 'Rename revenue metrics', at(9, 16, 20), { create: 3, update: 18, delete: 1 },
    { contributors: ['u_ana', 'u_ben'], source_commit_count: 4 }),
  ...SNOWFLAKE,
  person(217, 'u_chen', 'Fix customer keys', at(9, 8, 40), { update: 6 }),
  ...[216, 215, 214].map((seq, i): Commit => ({
    commit_id: `cmt_${seq}`, commit_seq: seq, kind: 'edit', message: 'dbt docs: refresh model descriptions',
    actor: 'u_ana', actor_kind: 'human', api_key_id: 'apk_dbt', correlation_id: `req_dbt${seq}`,
    automation: true, contributors: ['u_ana'], stats: { update: 120 - i * 17 },
    created_at: at(8, 18, 10 - i * 3),
  })),
  { commit_id: 'cmt_213', commit_seq: 213, kind: 'sync', message: 'Re-synced from the warehouse', actor: 'system',
    actor_kind: 'system', api_key_id: null, correlation_id: null, automation: true, stats: { create: 41, update: 9, delete: 2 },
    created_at: at(8, 7, 0) },
  person(212, 'u_dee', 'Add churn dashboard lineage', at(7, 15, 5), { create: 12, update: 4 },
    { contributors: ['u_dee', 'u_chen'], source_commit_count: 3 }),
  person(211, 'u_ana', 'Retire legacy CRM tables', at(7, 10, 30), { delete: 14 }),
]

export const MONTHS = {
  headSeq: HEAD, tz: 'UTC',
  months: [{ month: '2026-11', count: COMMITS.length, firstSeq: 211, lastSeq: HEAD, lastAt: at(9, 16, 20), days: [] }],
}

const SUMMARY = {
  groups: [
    { key: 'DOM', kind: 'container', label: 'Finance', entityType: 'Domain', status: 'unchanged',
      counts: { added: 2, modified: 31, removed: 1 }, childTotal: 34, deleted: false },
    { key: 'DOM2', kind: 'container', label: 'Customer', entityType: 'Domain', status: 'unchanged',
      counts: { added: 1, modified: 12, removed: 0 }, childTotal: 13, deleted: false },
  ],
  groupTotal: 2,
  counts: { added: 3, modified: 43, removed: 1 },
  impact: { Table: 21, Column: 26 },
}

/** Answers the routes History and the strip read. `logUpTo`: the newest commit Published holds. */
export function provenanceFetch(logUpTo = HEAD): typeof fetch {
  return async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const p = url.pathname
    const q = url.searchParams
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (/\/graphs\/[^/]+\/commits$/.test(p)) {
      const origin = q.get('origin')
      const before = q.get('before') ? Number(q.get('before')) : Infinity
      const limit = Number(q.get('limit') ?? 50)
      const listed = COMMITS.filter((c) => c.commit_seq <= logUpTo && c.commit_seq < before
        && (origin === 'automation' ? c.automation : origin === 'people' ? !c.automation : true))
      const page = listed.slice(0, limit)
      return json({ commits: page, userNames: USER_NAMES, apiKeyNames: API_KEY_NAMES, hasMore: false, nextBefore: null })
    }
    if (p.endsWith('/history/months')) return json(MONTHS)
    if (/\/commits\/[^/]+\/diff\/summary$/.test(p)) return json(SUMMARY)
    if (/\/commits\/[^/]+\/squashed$/.test(p)) return json({ commits: [], userNames: USER_NAMES, apiKeyNames: API_KEY_NAMES })
    const rev = p.match(/\/revisions\/(\d+)$/)
    if (rev) {
      const commit = COMMITS.find((c) => c.commit_seq === Number(rev[1])) ?? COMMITS[0]
      return json({ commit, userNames: USER_NAMES, headSeq: HEAD, changedSince: 40, limit: 100_000, openable: true, reason: null })
    }
    return json({ detail: 'not in the provenance harness' }, 404)
  }
}
