import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VersionDiffDialog } from './VersionDiffDialog'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

function version(over: Partial<OntologyDefinitionResponse>): OntologyDefinitionResponse {
  return {
    id: 'v1', schemaId: 'sc', name: 'Layer', version: 1, revision: 0,
    evolutionPolicy: 'reject', isPublished: true, isSystem: false, scope: 'universal',
    containmentEdgeTypes: [], lineageEdgeTypes: [], edgeTypeMetadata: {},
    entityTypeHierarchy: {}, rootEntityTypes: [],
    entityTypeDefinitions: {}, relationshipTypeDefinitions: {},
    createdAt: '', updatedAt: '',
    ...over,
  } as OntologyDefinitionResponse
}

describe('VersionDiffDialog', () => {
  it('reports the diff between two versions with per-section rows', () => {
    const base = version({
      id: 'v3', version: 3,
      entityTypeDefinitions: { Server: { name: 'Server' }, Rack: { name: 'Rack' } },
      relationshipTypeDefinitions: { HAS: { name: 'Has' } },
      containmentEdgeTypes: ['HAS'],
    })
    const target = version({
      id: 'v1', version: 1,
      entityTypeDefinitions: { Server: { name: 'Server v1' } }, // Rack removed, Server modified
      relationshipTypeDefinitions: { HAS: { name: 'Has' }, FEEDS: { name: 'Feeds' } }, // FEEDS added
      containmentEdgeTypes: [], // classification differs
    })

    render(<VersionDiffDialog base={base} target={target} onClose={vi.fn()} />)

    expect(screen.getByText('v3 → v1')).toBeInTheDocument()
    expect(screen.getByText(/4 differences/)).toBeInTheDocument()
    expect(screen.getByText(/feeds/i)).toBeInTheDocument()
    expect(screen.getByText(/rack/i)).toBeInTheDocument()
    expect(screen.getByText(/Containment classification differs/)).toBeInTheDocument()
  })

  it('says versions are identical when nothing differs and offers restore when allowed', () => {
    const a = version({ id: 'v2', version: 2 })
    const b = version({ id: 'v1', version: 1 })
    const onRestore = vi.fn()
    render(<VersionDiffDialog base={a} target={b} onRestore={onRestore} onClose={vi.fn()} />)

    expect(screen.getByText(/identical in content/)).toBeInTheDocument()
    screen.getByText(/Restore v1 as new draft/).click()
    expect(onRestore).toHaveBeenCalled()
  })
})
