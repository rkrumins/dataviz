import { useMemo } from 'react'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { DeploymentEntry } from '../lib/ontology-types'

interface DeploymentMatrix {
  entries: DeploymentEntry[]
  orphans: DeploymentEntry[]
  versionMismatches: Array<{
    schemaId: string
    schemaName: string
    entries: DeploymentEntry[]
  }>
  stats: {
    totalDs: number
    assignedDs: number
    orphanDs: number
    ontologyCount: number
  }
}

function deriveOntologyStatus(
  ont: OntologyDefinitionResponse,
): 'system' | 'published' | 'draft' {
  if (ont.isSystem) return 'system'
  if (ont.isPublished) return 'published'
  return 'draft'
}

export function useDeploymentMatrix(
  workspaces: WorkspaceResponse[],
  ontologies: OntologyDefinitionResponse[],
): DeploymentMatrix {
  return useMemo(() => {
    // Build a lookup map: ontologyId -> OntologyDefinitionResponse
    const ontologyById = new Map<string, OntologyDefinitionResponse>()
    for (const ont of ontologies) {
      ontologyById.set(ont.id, ont)
    }

    const entries: DeploymentEntry[] = []

    for (const ws of workspaces) {
      for (const ds of ws.dataSources) {
        const ont = ds.ontologyId ? ontologyById.get(ds.ontologyId) ?? null : null

        entries.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          dataSourceId: ds.id,
          dataSourceLabel: ds.label || ds.catalogItemId || ds.id,
          ontologyId: ds.ontologyId ?? null,
          ontologyName: ont?.name ?? null,
          ontologyVersion: ont?.version ?? null,
          ontologySchemaId: ont?.schemaId ?? null,
          ontologyStatus: ont ? deriveOntologyStatus(ont) : null,
          coveragePercent: null, // Coverage requires per-DS computation; null until enriched
        })
      }
    }

    // Orphans: no ontologyId or ontologyId not found in ontologies list
    const orphans = entries.filter(
      (e) => e.ontologyId === null || e.ontologyName === null,
    )

    // Version mismatches: group by schemaId, find groups with multiple distinct versions
    const bySchemaId = new Map<string, DeploymentEntry[]>()
    for (const entry of entries) {
      if (!entry.ontologySchemaId) continue
      const group = bySchemaId.get(entry.ontologySchemaId)
      if (group) {
        group.push(entry)
      } else {
        bySchemaId.set(entry.ontologySchemaId, [entry])
      }
    }

    const versionMismatches: DeploymentMatrix['versionMismatches'] = []
    for (const [schemaId, group] of bySchemaId) {
      const distinctVersions = new Set(
        group.map((e) => e.ontologyVersion).filter((v) => v !== null),
      )
      if (distinctVersions.size > 1) {
        // Use the first entry's name as schema name
        const schemaName = group[0]?.ontologyName ?? schemaId
        versionMismatches.push({ schemaId, schemaName, entries: group })
      }
    }

    const assignedDs = entries.length - orphans.length
    const stats = {
      totalDs: entries.length,
      assignedDs,
      orphanDs: orphans.length,
      ontologyCount: ontologies.length,
    }

    return { entries, orphans, versionMismatches, stats }
  }, [workspaces, ontologies])
}
