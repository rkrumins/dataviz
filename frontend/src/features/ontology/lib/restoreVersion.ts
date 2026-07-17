/**
 * restoreVersionAsDraft — bring an old version's content back as a new draft.
 *
 * Nothing is overwritten: the composition is `new-version from the latest`
 * (or reuse of the lineage's existing draft — the backend enforces one draft
 * per schema) followed by an update writing the old version's content into
 * that draft. Pure orchestration over injected service functions so it can
 * be unit-tested without the page.
 */
import type { OntologyDefinitionResponse, OntologyUpdateRequest } from '@/services/ontologyDefinitionService'

export interface RestoreServices {
  createNewVersion(id: string): Promise<OntologyDefinitionResponse>
  update(id: string, req: OntologyUpdateRequest): Promise<OntologyDefinitionResponse>
  listVersions(id: string): Promise<OntologyDefinitionResponse[]>
}

/** Platform built-ins (e.g. AGGREGATED) are injected on read marked is_system —
 *  never send them back. */
function stripSystem(defs: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(defs ?? {}).filter(([, def]) => !(def as Record<string, unknown>)?.is_system),
  )
}

export async function restoreVersionAsDraft(
  source: OntologyDefinitionResponse,
  latestId: string,
  services: RestoreServices,
): Promise<OntologyDefinitionResponse> {
  let draftId: string
  try {
    const draft = await services.createNewVersion(latestId)
    draftId = draft.id
  } catch (err) {
    // 409 — a draft already exists for this schema lineage (or the latest IS
    // an unpublished draft). Reuse it instead of failing.
    const versions = await services.listVersions(latestId)
    const existing = versions.find(v => !v.isPublished && !v.deletedAt)
    if (!existing) throw err
    draftId = existing.id
  }

  return services.update(draftId, {
    entityTypeDefinitions: stripSystem(source.entityTypeDefinitions as Record<string, unknown>),
    relationshipTypeDefinitions: stripSystem(source.relationshipTypeDefinitions as Record<string, unknown>),
    containmentEdgeTypes: source.containmentEdgeTypes ?? [],
    lineageEdgeTypes: source.lineageEdgeTypes ?? [],
    edgeTypeMetadata: source.edgeTypeMetadata ?? {},
    entityTypeHierarchy: source.entityTypeHierarchy ?? {},
    rootEntityTypes: source.rootEntityTypes ?? [],
  })
}
