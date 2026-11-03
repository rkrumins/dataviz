/**
 * The membership contract — `POST /{ws_id}/graph/members` — as the client sends
 * and reads it. Mirrors `backend/common/models/view_membership.py`: a spec names
 * seeds (by URN, or a search predicate) and how far they reach; a result lists
 * each entity in scope with why, the containers each sits in, counts, and every
 * limit the resolution reached. The canvas calls the feature Narrow.
 */
import type { Predicate } from './search'

/** Levels or hops; `'all'` is the whole way. */
export type Depth = number | 'all'

export interface MembershipExpand {
  /** What is inside each seed: 0, 1 or 2 levels, or everything. */
  children: Depth
  /** Lineage hops: 0–25, or the whole way. */
  upstream: Depth
  downstream: Depth
  /** What is inside the sources and consumers found: 0, 1 level, or everything. */
  partnerChildren: Depth
}

export interface MembershipSeeds {
  urns?: string[]
  query?: Predicate
}

export interface MembershipSpec {
  v: 1
  seeds: MembershipSeeds
  /** Where query seeds are looked for: this view's boundary, or the whole data source. */
  within: 'view' | 'dataSource'
  expand: MembershipExpand
}

export type MemberVia = 'seed' | 'inside' | 'upstream' | 'downstream' | 'partnerInside'

export interface MemberEntry {
  urn: string
  via: MemberVia
  /** Lineage hops from the seeds, for a source or consumer. */
  hops?: number | null
}

export type TruncationReason = 'seed_cap' | 'member_cap' | 'trace_cap' | 'deadline' | 'incomplete' | 'chains_cap'

export interface MembershipTruncation {
  reason: TruncationReason
  seen: number
  limit: number
}

export interface MembershipCounts {
  seeds: number
  /** null: "everything inside" — in scope, never enumerated, so not counted. */
  inside: number | null
  upstream: number
  downstream: number
  partnerInside: number | null
  total: number
}

export interface MembershipResult {
  specHash: string
  members: MemberEntry[]
  /** Members whose whole inside is in scope without being listed. */
  wholeSubtree: string[]
  /** Each member's containers, parent first, top-level last ([] = top level). */
  chains: Record<string, string[]>
  counts: MembershipCounts
  missingSeeds: number
  truncated: MembershipTruncation[]
  dataVersion: string
  elapsedMs: number
}

/** The request body: a spec, and whether to list the members (false: counts alone). */
export interface MembershipRequest {
  spec: MembershipSpec
  includeMembers?: boolean
}
