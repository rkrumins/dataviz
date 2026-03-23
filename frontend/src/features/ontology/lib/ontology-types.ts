import type { RelationshipTypeSchema } from '@/types/schema'

export interface RelTypeWithClassifications extends RelationshipTypeSchema {
  isContainment?: boolean
  isLineage?: boolean
  category?: 'structural' | 'flow' | 'metadata' | 'association'
  direction?: 'source-to-target' | 'target-to-source' | 'bidirectional'
}

export type ToastType = 'success' | 'error' | 'warning' | 'info'
export interface Toast { type: ToastType; message: string; id: number; action?: { label: string; onClick: () => void } }

export type OntologyTab = 'overview' | 'entities' | 'relationships' | 'coverage' | 'hierarchy' | 'usage' | 'history' | 'settings'
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
