import type { RelationshipTypeSchema } from '@/types/schema'

export interface RelTypeWithClassifications extends RelationshipTypeSchema {
  isContainment?: boolean
  isLineage?: boolean
  category?: 'structural' | 'flow' | 'metadata' | 'association'
  direction?: 'source-to-target' | 'target-to-source' | 'bidirectional'
  /** Platform built-in edge (e.g. the aggregation AGGREGATED rollup) — always present,
   *  shown read-only. The user did not author it and cannot edit or delete it. */
  isSystem?: boolean
}

/** Single source of truth for a new relationship type's visual defaults —
 *  used by both the RelationshipTypeEditor blank form and the Coverage
 *  panel's "Define" prefill so they can never disagree. */
export const DEFAULT_REL_VISUAL = {
  strokeColor: '#6366f1',
  strokeWidth: 2,
  strokeStyle: 'solid',
  animated: true,
  animationSpeed: 'normal',
  arrowType: 'arrow',
  curveType: 'bezier',
} as const

export type ToastType = 'success' | 'error' | 'warning' | 'info'
export interface Toast { type: ToastType; message: string; id: number; action?: { label: string; onClick: () => void } }

export type OntologyTab = 'overview' | 'schema' | 'hierarchy' | 'coverage' | 'health' | 'usage' | 'history' | 'settings'

/** @deprecated — old tab IDs for URL migration */
export type LegacyOntologyTab = 'entities' | 'relationships' | 'hierarchy' | 'usage' | 'history'
export type StatusFilter = 'all' | 'system' | 'published' | 'draft' | 'deleted'

export interface CoverageState {
  uncoveredEntityTypes: string[]
  uncoveredRelationshipTypes: string[]
  coveragePercent: number
}

export type EditorPanel =
  | null
  | { kind: 'entity'; data?: import('@/types/schema').EntityTypeSchema }
  | { kind: 'rel'; data?: RelTypeWithClassifications }

export interface DeploymentEntry {
  workspaceId: string
  workspaceName: string
  dataSourceId: string
  dataSourceLabel: string
  ontologyId: string | null
  ontologyName: string | null
  ontologyVersion: number | null
  ontologySchemaId: string | null
  ontologyStatus: 'system' | 'published' | 'draft' | null
  coveragePercent: number | null
}
