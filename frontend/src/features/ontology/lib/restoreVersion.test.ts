import { describe, expect, it, vi } from 'vitest'
import { restoreVersionAsDraft } from './restoreVersion'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

function version(over: Partial<OntologyDefinitionResponse>): OntologyDefinitionResponse {
  return {
    id: 'v1', schemaId: 'sc', name: 'L', version: 1, revision: 0,
    evolutionPolicy: 'reject', isPublished: true, isSystem: false, scope: 'universal',
    containmentEdgeTypes: ['HAS'], lineageEdgeTypes: ['FEEDS'], edgeTypeMetadata: {},
    entityTypeHierarchy: {}, rootEntityTypes: ['Server'],
    entityTypeDefinitions: { Server: { name: 'Server' } },
    relationshipTypeDefinitions: {
      HAS: { name: 'Has', is_containment: true },
      AGGREGATED: { name: 'Aggregated', is_system: true },
    },
    createdAt: '', updatedAt: '',
    ...over,
  } as OntologyDefinitionResponse
}

describe('restoreVersionAsDraft', () => {
  it('creates a draft from the latest version and writes the old content into it (system types stripped)', async () => {
    const update = vi.fn().mockImplementation((id, req) => Promise.resolve(version({ id, version: 4, ...req })))
    const services = {
      createNewVersion: vi.fn().mockResolvedValue(version({ id: 'v4', version: 4, isPublished: false })),
      update,
      listVersions: vi.fn(),
    }
    const old = version({ id: 'v2', version: 2 })

    const draft = await restoreVersionAsDraft(old, 'v3', services)

    expect(services.createNewVersion).toHaveBeenCalledWith('v3')
    expect(update).toHaveBeenCalledWith('v4', expect.objectContaining({
      containmentEdgeTypes: ['HAS'],
      lineageEdgeTypes: ['FEEDS'],
    }))
    const sentRels = update.mock.calls[0][1].relationshipTypeDefinitions as Record<string, unknown>
    expect(sentRels).toHaveProperty('HAS')
    expect(sentRels).not.toHaveProperty('AGGREGATED') // injected built-in never sent back
    expect(draft.id).toBe('v4')
    expect(services.listVersions).not.toHaveBeenCalled()
  })

  it('reuses the lineage draft when new-version 409s', async () => {
    const services = {
      createNewVersion: vi.fn().mockRejectedValue(new Error('409: a draft already exists')),
      update: vi.fn().mockImplementation((id) => Promise.resolve(version({ id, version: 4, isPublished: false }))),
      listVersions: vi.fn().mockResolvedValue([
        version({ id: 'v4', version: 4, isPublished: false }),
        version({ id: 'v3', version: 3, isPublished: true }),
      ]),
    }

    const draft = await restoreVersionAsDraft(version({ id: 'v2', version: 2 }), 'v3', services)

    expect(services.listVersions).toHaveBeenCalledWith('v3')
    expect(services.update).toHaveBeenCalledWith('v4', expect.anything())
    expect(draft.id).toBe('v4')
  })

  it('propagates the failure when no draft exists to reuse', async () => {
    const boom = new Error('409: nope')
    const services = {
      createNewVersion: vi.fn().mockRejectedValue(boom),
      update: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([version({ id: 'v3', version: 3, isPublished: true })]),
    }
    await expect(restoreVersionAsDraft(version({ id: 'v2' }), 'v3', services)).rejects.toBe(boom)
    expect(services.update).not.toHaveBeenCalled()
  })

  it('surfaces a failed content write (step 2) to the caller', async () => {
    const services = {
      createNewVersion: vi.fn().mockResolvedValue(version({ id: 'v4', version: 4, isPublished: false })),
      update: vi.fn().mockRejectedValue(new Error('write failed')),
      listVersions: vi.fn(),
    }
    await expect(restoreVersionAsDraft(version({ id: 'v2' }), 'v3', services)).rejects.toThrow('write failed')
  })
})
