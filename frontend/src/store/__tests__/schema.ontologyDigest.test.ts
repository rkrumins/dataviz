/**
 * The ontology digest has to survive the trip from the wire into the store.
 *
 * The backend hashes the whole ontology projection and ships it on GraphSchema;
 * a view stamps the same hash onto its row when it's saved. The ViewWizard's
 * drift banner is a pure equality test between the two (`hasOntologyDrifted`),
 * and it is deliberately silent when either side is null — so a digest that
 * never reaches the store doesn't fail loudly. It just means the banner can
 * never fire, for any view, ever.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useSchemaStore } from '../schema'
import { hasOntologyDrifted } from '@/components/schema/OntologyDriftBanner'
import type { GraphSchema } from '@/providers/GraphDataProvider'

function entityType(id: string) {
  return {
    id,
    name: id,
    pluralName: `${id}s`,
    description: '',
    visual: { icon: 'Box', color: '#fff', shape: 'rectangle', size: 'medium', borderStyle: 'solid', showInMinimap: true },
    fields: [],
    hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false },
    behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand' },
  }
}

function graphSchema(over: Partial<GraphSchema> = {}): GraphSchema {
  return {
    version: '1.0.0',
    entityTypes: [entityType('platform')],
    relationshipTypes: [],
    rootEntityTypes: ['platform'],
    containmentEdgeTypes: ['HAS'],
    lineageEdgeTypes: ['FLOWS_TO'],
    ontologyDigest: 'digest-current',
    ...over,
  } as GraphSchema
}

const SCOPE = { workspaceId: 'ws1', dataSourceId: 'ds1' }

describe('schema store — ontologyDigest', () => {
  beforeEach(() => {
    useSchemaStore.getState().reset()
  })

  it('carries the digest from the backend payload into the store', () => {
    useSchemaStore.getState().loadFromBackend(graphSchema(), SCOPE)

    expect(useSchemaStore.getState().schema?.ontologyDigest).toBe('digest-current')
  })

  it('a view saved against an older ontology reads as drifted', () => {
    // The whole point of the field. This is the ViewWizard's check, verbatim.
    useSchemaStore.getState().loadFromBackend(graphSchema(), SCOPE)
    const current = useSchemaStore.getState().schema?.ontologyDigest

    expect(hasOntologyDrifted('digest-from-when-the-view-was-saved', current)).toBe(true)
    expect(hasOntologyDrifted('digest-current', current)).toBe(false)
  })

  it('a digest-only change still lands, even when the types are untouched', () => {
    // The store short-circuits writes when the payload looks unchanged. The digest
    // hashes the ENTIRE ontology projection, so it can move while the converted
    // entity/relationship types stay byte-identical — and `version` is hardcoded
    // "1.0.0" backend-side, so it never discriminates anything. If the digest isn't
    // part of that identity check, the new one is swallowed and the store serves a
    // stale hash: a silent false negative on exactly the check this feature exists for.
    useSchemaStore.getState().loadFromBackend(graphSchema({ ontologyDigest: 'digest-v1' }), SCOPE)
    expect(useSchemaStore.getState().schema?.ontologyDigest).toBe('digest-v1')

    useSchemaStore.getState().loadFromBackend(graphSchema({ ontologyDigest: 'digest-v2' }), SCOPE)
    expect(useSchemaStore.getState().schema?.ontologyDigest).toBe('digest-v2')
  })

  it('a synthetic schema nulls the digest rather than faking one', () => {
    // Cache-miss fallback: the backend builds a schema from the ontology with
    // `ontologyDigest: None` on purpose (build_synthetic_schema). Null means
    // "can't check" — the banner must stay silent instead of crying wolf.
    useSchemaStore.getState().loadFromBackend(graphSchema({ ontologyDigest: null }), SCOPE)

    expect(useSchemaStore.getState().schema?.ontologyDigest).toBeNull()
    expect(hasOntologyDrifted('any-view-digest', useSchemaStore.getState().schema?.ontologyDigest)).toBe(false)
  })
})
