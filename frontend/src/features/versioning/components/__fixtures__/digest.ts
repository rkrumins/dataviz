/**
 * Digest fixtures, in the API's shape (`GET …/graphs/{id}/digest`, `…/watch`): the tests' and the
 * digest harness's (`src/harness/digestHarness.tsx`).
 */
import type { DigestVersion, GraphDigest, GraphWatching } from '@/services/versioningApiService'

export const ME = 'usr_me'

export function version(seq: number, over: Partial<DigestVersion> = {}): DigestVersion {
  return {
    seq, version: `cmt_${seq}`, kind: 'squash_publish', at: `2026-11-16T${String(9 + (seq % 9)).padStart(2, '0')}:15:00+00:00`,
    author: { id: 'usr_alice', name: 'Alice Smith' }, message: `Change ${seq}`,
    counts: { added: 12, changed: 3, removed: 1 }, ...over,
  }
}

export function digest(over: Partial<GraphDigest> = {}): GraphDigest {
  return {
    since: { seq: 212, at: '2026-11-13T16:40:00+00:00' }, window: 'since_seen',
    head: { seq: 215, version: 'cmt_215' },
    versions: [
      version(215, { message: 'Owners for the Q4 finance tables' }),
      version(214, { kind: 'sync', author: { id: null, name: null }, message: 'Nightly sync from the warehouse', counts: null }),
      version(213, { author: { id: ME, name: 'Morgan Lee' }, message: 'Retire the legacy ledger', counts: { added: 0, changed: 2, removed: 40 } }),
    ],
    total: 3, truncated: false,
    authors: [
      { id: 'usr_alice', name: 'Alice Smith', versions: 1 },
      { id: null, name: null, versions: 1 },
      { id: ME, name: 'Morgan Lee', versions: 1 },
    ],
    reviewsWaiting: [
      { id: 'pr_7', title: 'Rename the revenue measures', url: '/workspaces/ws1/reviews?pr=pr_7',
        author: { id: 'usr_carol', name: 'Carol Diaz' }, at: '2026-11-16T08:05:00+00:00' },
    ],
    reviewsMore: false,
    watchedChanged: [
      { urn: 'urn:li:dataset:orders', entityId: 'urn:uuid:orders', name: 'Orders', change: 'changed', seq: 215, at: '2026-11-16T14:15:00+00:00' },
      { urn: 'urn:li:dataset:ledger_v1', entityId: 'urn:uuid:ledger', name: 'Legacy ledger', change: 'removed', seq: 213, at: '2026-11-16T12:15:00+00:00' },
    ],
    ...over,
  }
}

/** Fifty versions shown of `total` (null: the 7-day window, cut short). */
export function truncated(total: number | null): GraphDigest {
  const versions = Array.from({ length: 50 }, (_, i) => version(400 - i, {
    author: i % 3 === 0 ? { id: 'usr_alice', name: 'Alice Smith' } : { id: 'usr_bob', name: 'Bob Okafor' },
    message: i % 3 === 0 ? `Steward review ${400 - i}` : `Import batch ${400 - i}`,
    kind: i % 3 === 0 ? 'squash_publish' : 'import',
    counts: i % 3 === 0 ? { added: 1, changed: 4, removed: 0 } : { added: 250, changed: 0, removed: 0 },
  }))
  return digest({
    since: total == null ? null : { seq: 400 - total, at: '2026-10-02T10:00:00+00:00' },
    window: total == null ? 'last_7_days' : 'since_seen',
    head: { seq: 400, version: 'cmt_400' }, versions, total, truncated: true,
    authors: [{ id: 'usr_bob', name: 'Bob Okafor', versions: 33 }, { id: 'usr_alice', name: 'Alice Smith', versions: 17 }],
    reviewsWaiting: [], watchedChanged: [],
  })
}

export const NOTHING_NEW: GraphDigest = digest({
  since: { seq: 215, at: '2026-11-16T15:02:00+00:00' }, versions: [], total: 0, authors: [],
  reviewsWaiting: [], watchedChanged: [],
})

export function watching(over: Partial<GraphWatching> = {}): GraphWatching {
  return { graph: false, entities: [], entitiesMax: 200, ...over }
}
