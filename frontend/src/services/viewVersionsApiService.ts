/**
 * View versions — the history of a view's DESIGN (its layers, assignments and settings).
 *
 * Not graph version control: drafts, commits and review requests version the graph's data
 * (`versioningApiService`). These versions exist for every view, version-controlled source or
 * not, and are numbered v1, v2, … Never call them commits.
 *
 * API scope: /api/v1/views/{viewId}/versions
 */
import { authFetch } from './apiClient'
import type { View } from './viewApiService'

export type ViewVersionSource =
  | 'baseline' | 'create' | 'wizard' | 'import' | 'restore' | 'promote' | 'export' | 'manual' | 'snapshot'

/** Where an imported version came from, as its file said. */
export interface ViewVersionOrigin {
  environment?: string | null
  viewId?: string | null
  version?: number | null
  hash?: string | null
  portableId?: string | null
  exportedAt?: string | null
  exportedBy?: string | null
  fileName?: string | null
}

export interface ViewVersionSummary {
  version: number
  contentHash: string
  name: string
  description?: string | null
  icon?: string | null
  tags: string[]
  viewType?: string | null
  source: ViewVersionSource
  message?: string | null
  parentVersion?: number | null
  stats: Record<string, number>
  provenance?: Record<string, unknown> | null
  ontologyDigest?: string | null
  createdBy?: string | null
  createdByName?: string | null
  createdAt: string
}

export interface ViewDefinitionDiff {
  metadata: Array<{ field: string; from: unknown; to: unknown }>
  layers: {
    added: Array<{ id: string; name?: string }>
    removed: Array<{ id: string; name?: string }>
    changed: Array<{ id: string; name?: string; fields: string[] }>
    reordered: boolean
    /** Every layer on either side, id → name. */
    names?: Record<string, string>
  }
  assignments: {
    added: number
    removed: number
    moved: number
    modified: number
    samples: {
      added: string[]
      removed: string[]
      moved: Array<{ urn: string; from: string | null; to: string | null }>
      modified: string[]
    }
    truncated: boolean
  }
  settings: string[]
  identical: boolean
}

export interface ViewVersionStatus {
  headVersion: number | null
  headHash: string | null
  workingHash: string
  designChanged: boolean
  labelChanged: boolean
  dirty: boolean
  portableId?: string | null
  origin?: (ViewVersionOrigin & { importedAsVersion: number; importedAt: string }) | null
}

export interface ViewVersionPage {
  items: ViewVersionSummary[]
  hasMore: boolean
  nextBefore: number | null
  workingCopy: ViewVersionStatus & { summary?: ViewDefinitionDiff }
  portableId?: string | null
}

/** React Query keys for a view's versions. Here rather than beside the hooks so a service that
 *  changes a view (a layout save) can mark them stale without importing hooks. */
export const VIEW_VERSIONS_QUERY_KEY = 'view-versions' as const
export const VIEW_VERSION_STATUS_QUERY_KEY = 'view-version-status' as const

const base = (viewId: string) => `/api/v1/views/${encodeURIComponent(viewId)}/versions`

export function getViewVersionStatus(viewId: string): Promise<ViewVersionStatus> {
  return authFetch<ViewVersionStatus>(`${base(viewId)}/status`)
}

export function listViewVersions(
  viewId: string, opts: { limit?: number; before?: number } = {},
): Promise<ViewVersionPage> {
  const params = new URLSearchParams()
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.before) params.set('before', String(opts.before))
  const qs = params.toString()
  return authFetch<ViewVersionPage>(`${base(viewId)}${qs ? `?${qs}` : ''}`)
}

export function saveViewVersion(
  viewId: string, message?: string,
): Promise<{ version: ViewVersionSummary; created: boolean }> {
  return authFetch(`${base(viewId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message || null }),
  })
}

export function compareViewVersions(
  viewId: string, from: number, to: number | 'working' = 'working',
): Promise<{ from: number; to: number | 'working'; diff: ViewDefinitionDiff }> {
  return authFetch(`${base(viewId)}/compare?from=${from}&to=${to}`)
}

export function getViewVersion(
  viewId: string, version: number,
): Promise<ViewVersionSummary & { definition: Record<string, unknown> }> {
  return authFetch(`${base(viewId)}/${version}`)
}

/** Restore makes the old design the view's design again AS A NEW VERSION (nothing is rewritten);
 *  unsaved changes are saved first as `snapshot`. The graph data isn't touched. */
export function restoreViewVersion(
  viewId: string, version: number,
): Promise<{ view: View; version: ViewVersionSummary; snapshot: ViewVersionSummary | null }> {
  return authFetch(`${base(viewId)}/${version}/restore`, { method: 'POST' })
}
