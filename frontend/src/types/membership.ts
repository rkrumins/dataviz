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

// ── Views made from a query (`/views/from-members`, `/views/{id}/membership`) ──

/** `live` keeps the members in step with the data; `snapshot` keeps them as they are. */
export type MembershipMode = 'live' | 'snapshot'
export type LayoutKind = 'source' | 'template' | 'auto' | 'stages' | 'custom'
export type MembershipOrigin = 'narrow' | 'search' | 'savedQuery' | 'wizard' | 'api'

/** One query a view's members come from — a query seed is searched in `readIn`. */
export interface MembershipSource {
  spec: MembershipSpec
  readIn?: string
  layerId?: string
  label?: string
}

export interface MembershipLayout {
  kind: LayoutKind
  nest?: boolean
  sourceViewId?: string
  templateId?: string
  fallbackLayerId?: string
}

export interface MembershipProvenance {
  origin: MembershipOrigin
  viewId?: string
  savedQueryId?: string
  createdAt?: string
  createdBy?: string
}

export interface MembershipDefinition {
  v: 1
  mode: MembershipMode
  sources: MembershipSource[]
  layout: MembershipLayout
  exclude: string[]
  overrides: Record<string, { layerId?: string; orderKey?: string; logicalNodeId?: string; at?: string }>
  provenance: MembershipProvenance
}

/** Layers with no members are kept (`all`) or left out (`withResults`). */
export type KeepLayers = 'withResults' | 'all'

export interface PlanRequest {
  sources: MembershipSource[]
  layout: MembershipLayout
  layers?: Array<Record<string, unknown>>
  keep: KeepLayers
  exclude?: string[]
}

export interface PlanLayer {
  id: string
  name: string
  color?: string | null
  count: number
  linkLayerId?: string | null
  kept: boolean
}

/** What saving would make: entries against the limit, layer by layer. */
export interface MembershipPlan {
  keys: number
  members: number
  containers: number
  included: number
  limit: number
  overCap: boolean
  layers: PlanLayer[]
  fallback: number
  truncated: MembershipTruncation[]
  missingSeeds: number
  dataVersion: string
}

export interface FromMembersRequest {
  name: string
  description?: string
  icon?: string
  tags?: string[]
  visibility: 'private' | 'workspace' | 'enterprise'
  workspaceId: string
  dataSourceId?: string
  mode: MembershipMode
  sources: MembershipSource[]
  layout: MembershipLayout
  layers?: Array<Record<string, unknown>>
  keep: KeepLayers
  exclude?: string[]
  provenance: MembershipProvenance
}

export type MembershipStatusKind =
  | 'pending' | 'updating' | 'ok' | 'partial' | 'over_cap' | 'held' | 'failed' | 'paused' | 'source_missing' | 'frozen'

export interface ReadInView {
  viewId: string
  /** Null: the reader can't open that view. */
  name: string | null
  available: boolean
}

export interface MembershipStatus {
  mode: MembershipMode
  status: MembershipStatusKind
  detail?: Record<string, unknown> | null
  revision: number
  definition: MembershipDefinition
  definitionHash: string
  counts?: { members?: number; containers?: number; included?: number; fallback?: number; missingSeeds?: number; perLayer?: Record<string, number> } | null
  keys: number
  limit: number
  lastAppliedAt?: string | null
  lastDiff?: { added: number; removed: number; moved: number; addedSample?: string[]; removedSample?: string[]; at?: string } | null
  truncated: MembershipTruncation[]
  readIn: ReadInView[]
  alwaysIncluded: string[]
  excluded: string[]
}

export interface MembershipUpdate {
  ifDefinitionHash: string
  mode?: MembershipMode
  sources?: MembershipSource[]
  layout?: MembershipLayout
  exclude?: string[]
}

export interface MemberOps {
  exclude?: string[]
  unexclude?: string[]
  include?: Array<{ urn: string; layerId: string }>
  uninclude?: string[]
}

export type RefreshOutcome =
  | 'applied' | 'unchanged' | 'held' | 'over_cap' | 'deferred' | 'busy' | 'fenced' | 'source_missing' | 'failed'

export interface RefreshResult {
  outcome: RefreshOutcome
  detail: Record<string, unknown>
  diff?: { added: number; removed: number; moved: number } | null
  membership: MembershipStatus
}
