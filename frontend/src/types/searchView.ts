/**
 * Subset views — a view of a search's matches inside another view (its base) —
 * as the client sends and reads them. Mirrors `backend/common/models/search_view.py`.
 *
 * A subset view stores its search and its base, never its matches: each layer is
 * read page by page from `POST /{ws}/graph/search/view-feed`. By default its
 * layers are its base's, read live and placed by type, plus "Other matches".
 */
import type { MembershipProvenance, ReadInView } from './membership'
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { Predicate } from './search'

/** Where the matches are looked for: inside the base view, or the whole data source. */
export type SubsetWithin = 'view' | 'dataSource'
/** Where the layers come from: the base, live (`inherit`), or the view's own (`own`). */
export type SubsetLayout = 'inherit' | 'own'

/** The id of the layer a subset adds for matches whose type no layer claims. */
export const REST_LAYER_ID = 'other-matches'

/** What a subset keeps beside its search's matches. Each is one relationship to a
 *  match, kept as part of its search, so the view stays live at any size. Levels
 *  and kinds count only while their choice is on; unset, they are never sent. */
export interface SubsetInclude {
  /** What is inside a match: every level, or `contentsLevels` of them. */
  contents: boolean
  /** Levels inside (1–20); unset: every level. */
  contentsLevels?: number
  /** Only these kinds inside (entity types, a set); unset: every kind. */
  contentsKinds?: string[]
  /** What contains a match: up to the top, or `containersLevels` up. */
  containers: boolean
  /** Levels up (1–20); unset: up to the top. */
  containersLevels?: number
  /** Only these kinds of container; unset: every kind. */
  containersKinds?: string[]
  /** One lineage step upstream: what feeds a match. */
  upstream: boolean
  /** One lineage step downstream: what a match feeds. */
  downstream: boolean
}

export const NO_INCLUDE: SubsetInclude = { contents: false, containers: false, upstream: false, downstream: false }

/** `config.search` — written only by the server. */
export interface SearchViewDefinition {
  v: 1
  predicate: Predicate
  within: SubsetWithin
  readIn?: string
  layout: SubsetLayout
  /** What it keeps beside the matches. */
  include?: SubsetInclude
  /** Base layers a following subset leaves out, with their matches. */
  hiddenLayers?: string[]
  provenance: MembershipProvenance
}

export interface SubsetLayerSpec {
  name: string
  color?: string
  entityTypes: string[]
}

/** `POST /views/from-search`. */
export interface FromSearchRequest {
  name: string
  description?: string
  icon?: string
  tags?: string[]
  visibility: 'private' | 'workspace' | 'enterprise'
  workspaceId: string
  dataSourceId?: string | null
  predicate: Predicate
  within: SubsetWithin
  readIn?: string
  layout: SubsetLayout
  /** An own layout's layers of types (at most 12). */
  layers?: SubsetLayerSpec[]
  /** The name of the layer for every other match; null: none. */
  rest?: string | null
  include?: SubsetInclude
  /** A following subset's base layers to leave out (`inherit` only). */
  hiddenLayers?: string[]
  provenance: MembershipProvenance
}

/** `PUT /views/{id}/search`. */
export interface SearchViewUpdate {
  ifDefinitionHash: string
  predicate?: Predicate
  layout?: SubsetLayout
  include?: SubsetInclude
  hiddenLayers?: string[]
}

/** A layer as a subset shows it, and what feeds it. */
export interface SubsetLayer {
  id: string
  name: string
  color?: string | null
  /** The types it holds; for the rest layer, empty. */
  entityTypes: string[]
  rest: boolean
  /** The rest layer holds every type but these. */
  excludedTypes: string[]
  /** Left out of a following subset, with its matches. */
  hidden?: boolean
}

export type SubsetStatusKind = 'ok' | 'base_missing'

/** `GET /views/{id}/search`. */
export interface SearchViewStatus {
  definition: SearchViewDefinition
  definitionHash: string
  status: SubsetStatusKind
  /** The base view; its name is null for a reader who can't open it. */
  base: ReadInView | null
  layers: SubsetLayer[]
  /** It follows its base, but the base's placement is more than a search can follow
   *  (`placedByTypeReason` says why): here its matches are placed by type. */
  placedByType: boolean
  placedByTypeReason?: string | null
}

export interface SubsetSummary {
  viewId: string
  name: string
  layout: SubsetLayout
  visibility: string
  updatedAt?: string | null
}

/** `GET /views/{id}/subsets`: `count` counts every one; `items` those the caller can open. */
export interface SubsetList {
  count: number
  items: SubsetSummary[]
}

/** `POST /{ws}/graph/search/view-feed?viewId=` — one page of one layer. */
export interface ViewFeedRequest {
  layerId: string
  cursor?: string
  sessionId?: string
  waitMs?: number
  refresh?: boolean
}

export interface AncestorStep {
  urn: string
  displayName: string
  entityType: string
}

/** A match as a feed lists it: the node, and where it sits (root first). */
export type FeedNode = GraphNode & { ancestorPath?: AncestorStep[] }

export interface ViewFeedPage {
  layerId: string
  nodes: FeedNode[]
  cursor?: string | null
  /** Exact once `status` is complete; while running, found so far. */
  totalCount?: number | null
  countStatus: 'exact' | 'lowerBound'
  status: 'complete' | 'running'
  sessionId?: string | null
  /** A recent answer, read before the data last changed (`asOf`). */
  stale: boolean
  asOf?: string | null
  /** More matches than the canvas lists: search in the layer, or export, for the rest. */
  capped: boolean
  /** Rows listed so far, this page included. */
  delivered: number
  dataVersion?: string | null
}

/** Whether a stored config is a subset view's. */
export function isSubsetConfig(config: { search?: unknown } | null | undefined): boolean {
  return Boolean(config && typeof config.search === 'object' && config.search !== null)
}
