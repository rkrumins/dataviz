/**
 * PackageOntologyPicker — the semantic layer of a new data source copied from a view package.
 * Pinned here:
 *   - a package from this environment: its own layer is chosen with no scoring, and a layer that
 *     changed since the export says so (drift); another can still be chosen, scored;
 *   - from elsewhere: the package's type stats are scored as the onboarding wizards score a graph
 *     (provider-stats shape, every layer), and the best fit that covers anything is chosen — never
 *     a 0% one, nor one of the layers this user can't see; a choice made since stands;
 *   - while the scores load, or when they can't be had, every layer is still a manual choice (and
 *     the package's own layer stays chosen);
 *   - "Create from this package" saves the suggestion as a draft layer and chooses it.
 */
import { useCallback, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OntologyDefinitionResponse, OntologyMatchResult } from '@/services/ontologyDefinitionService'
import type { OntologyMatch, PackageTypeStats } from '@/services/viewTransferApiService'

const suggestMock = vi.fn()
const createMock = vi.fn()
let ontologies: OntologyDefinitionResponse[] = []

vi.mock('@/services/ontologyDefinitionService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/ontologyDefinitionService')>()
  return {
    ...actual,
    ontologyDefinitionService: { ...actual.ontologyDefinitionService, suggest: (...a: unknown[]) => suggestMock(...a) },
  }
})
vi.mock('@/features/ontology/hooks/useOntologies', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/ontology/hooks/useOntologies')>()),
  useOntologies: () => ({ data: ontologies }),
}))
vi.mock('@/features/ontology/hooks/useOntologyMutations', () => ({
  useOntologyMutations: () => ({ create: { mutateAsync: (...a: unknown[]) => createMock(...a), isPending: false } }),
}))

import { PackageOntologyPicker } from '../PackageOntologyPicker'

function layer(id: string, name: string, extra: Partial<OntologyDefinitionResponse> = {}): OntologyDefinitionResponse {
  return {
    id, name, version: 1, description: null, isPublished: true,
    entityTypeDefinitions: { dataset: {} }, relationshipTypeDefinitions: { PRODUCES: {} },
    ...extra,
  } as OntologyDefinitionResponse
}

function score(id: string, name: string, jaccard: number): OntologyMatchResult {
  return {
    ontologyId: id, ontologyName: name, version: 1, jaccardScore: jaccard,
    coveredEntityTypes: jaccard > 0 ? ['dataset'] : [], uncoveredEntityTypes: jaccard > 0 ? ['job'] : ['dataset', 'job'],
    coveredRelationshipTypes: jaccard > 0 ? ['PRODUCES'] : [], uncoveredRelationshipTypes: jaccard > 0 ? [] : ['PRODUCES'],
    totalEntityTypes: 2, totalRelationshipTypes: 1,
  }
}

const STATS: PackageTypeStats = {
  nodeCount: 120, edgeCount: 80, entityTypeCounts: { dataset: 100, job: 20 }, edgeTypeCounts: { PRODUCES: 80 },
}
const SUGGESTED = { name: 'Suggested', entityTypeDefinitions: { dataset: {}, job: {} }, relationshipTypeDefinitions: { PRODUCES: {} } }
const SAME_ENV: OntologyMatch = { exact: { ontologyId: 'o_own', name: 'Finance', version: 3 }, drift: false, sameEnvironment: true }
const ELSEWHERE: OntologyMatch = { exact: null, drift: false, sameEnvironment: false }

const changes: Array<string | null> = []

function Picker({ match, initial }: { match: OntologyMatch | null; initial?: string | null }) {
  const [value, setValue] = useState<string | null | undefined>(initial)
  const onChange = useCallback((id: string | null) => { changes.push(id); setValue(id) }, [])
  return <PackageOntologyPicker match={match} typeStats={STATS} value={value} onChange={onChange} draftName="Lineage Schema" />
}

beforeEach(() => {
  vi.clearAllMocks()
  changes.length = 0
  ontologies = [layer('o_own', 'Finance', { version: 3 }), layer('o_fin', 'Finance (shared)'), layer('o_ops', 'Operations')]
})

describe('a package from this environment', () => {
  it('chooses its own semantic layer, with nothing to score', async () => {
    render(<Picker match={SAME_ENV} />)
    await waitFor(() => expect(changes).toEqual(['o_own']))
    expect(screen.getByText('Chosen')).toBeInTheDocument()
    expect(screen.getByText(/The package’s own semantic layer/)).toBeInTheDocument()
    expect(screen.queryByText(/changed since the package was exported/)).not.toBeInTheDocument()
    expect(suggestMock).not.toHaveBeenCalled()
  })

  it('says when that layer changed since the export', async () => {
    render(<Picker match={{ ...SAME_ENV, drift: true }} />)
    expect(await screen.findByText(/It has changed since the package was exported/)).toBeInTheDocument()
  })

  it('scores the others once another is asked for, keeping its own chosen meanwhile', async () => {
    suggestMock.mockResolvedValue({ suggested: SUGGESTED, matchingOntologies: [score('o_fin', 'Finance (shared)', 0.6)], mergedVariants: {} })
    render(<Picker match={SAME_ENV} />)
    await waitFor(() => expect(changes).toEqual(['o_own']))
    fireEvent.click(screen.getByRole('button', { name: 'Choose another semantic layer' }))
    expect(await screen.findByText('BEST FIT')).toBeInTheDocument()
    expect(changes).toEqual(['o_own'])
    fireEvent.click(screen.getByText('Operations'))
    expect(changes).toEqual(['o_own', 'o_ops'])
  })
})

describe('a package from elsewhere', () => {
  it('scores the package’s types as onboarding scores a graph, and chooses the best fit', async () => {
    suggestMock.mockResolvedValue({
      suggested: SUGGESTED, mergedVariants: {},
      matchingOntologies: [score('o_ops', 'Operations', 0.2), score('o_fin', 'Finance (shared)', 0.6)],
    })
    render(<Picker match={ELSEWHERE} />)
    await waitFor(() => expect(changes).toEqual(['o_fin']))
    const [stats, base, minScore] = suggestMock.mock.calls[0]
    expect(stats).toMatchObject({
      totalNodes: 120, totalEdges: 80,
      entityTypeStats: [expect.objectContaining({ id: 'dataset', count: 100 }), expect.objectContaining({ id: 'job', count: 20 })],
      edgeTypeStats: [expect.objectContaining({ id: 'PRODUCES', count: 80 })],
    })
    expect(base).toBeUndefined()
    expect(minScore).toBe(0)
    expect(screen.getByText('BEST FIT')).toBeInTheDocument()
    // The denominator behind every percentage.
    expect(screen.getByText((_, el) => el?.tagName === 'P'
      && /has 2 entity types and 1 relationship type\./.test(el.textContent ?? ''))).toBeInTheDocument()
  })

  it('chooses nothing when no layer covers anything, and keeps “No semantic layer” chosen', async () => {
    suggestMock.mockResolvedValue({ suggested: SUGGESTED, matchingOntologies: [score('o_fin', 'Finance (shared)', 0)], mergedVariants: {} })
    render(<Picker match={null} />)
    expect(await screen.findByText(/Layers are ranked by how much of it they cover/)).toBeInTheDocument()
    expect(changes).toEqual([])
    expect(screen.queryByText('BEST FIT')).not.toBeInTheDocument()
  })

  it('never chooses a best fit no card shows (a layer this user can’t see)', async () => {
    suggestMock.mockResolvedValue({
      suggested: SUGGESTED, mergedVariants: {},
      matchingOntologies: [score('o_hidden', 'Someone else’s', 0.9), score('o_fin', 'Finance (shared)', 0.6)],
    })
    render(<Picker match={ELSEWHERE} />)
    expect(await screen.findByText(/Layers are ranked by how much of it they cover/)).toBeInTheDocument()
    expect(changes).toEqual([])
  })

  it('says it is still working out the recommendation until it has chosen', async () => {
    let answer: (v: unknown) => void = () => {}
    suggestMock.mockReturnValue(new Promise((r) => { answer = r }))
    const pending = vi.fn()
    render(<PackageOntologyPicker match={ELSEWHERE} typeStats={STATS} value={undefined} onChange={(id) => changes.push(id)}
      draftName="Lineage Schema" onPending={pending} />)
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(true))
    answer({ suggested: SUGGESTED, matchingOntologies: [score('o_fin', 'Finance (shared)', 0)], mergedVariants: {} })
    await waitFor(() => expect(pending).toHaveBeenLastCalledWith(false))
  })

  it('never overrides a choice already made', async () => {
    suggestMock.mockResolvedValue({ suggested: SUGGESTED, matchingOntologies: [score('o_fin', 'Finance (shared)', 0.6)], mergedVariants: {} })
    render(<Picker match={ELSEWHERE} initial={null} />)
    expect(await screen.findByText('BEST FIT')).toBeInTheDocument()
    expect(changes).toEqual([])
  })

  it('is still a manual choice while the scores load', async () => {
    suggestMock.mockReturnValue(new Promise(() => {}))
    render(<Picker match={ELSEWHERE} />)
    expect(await screen.findByText(/Matching the package’s data against your semantic layers/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Operations'))
    expect(changes).toEqual(['o_ops'])
    fireEvent.click(screen.getByText('No semantic layer'))
    expect(changes).toEqual(['o_ops', null])
  })

  it('falls back to a manual list when the layers can’t be scored', async () => {
    suggestMock.mockRejectedValue(new Error('You may not score semantic layers.'))
    render(<Picker match={ELSEWHERE} />)
    expect(await screen.findByText('You may not score semantic layers.')).toBeInTheDocument()
    expect(screen.getByText(/You can still choose a layer by hand/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create from this package/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Finance (shared)'))
    expect(changes).toEqual(['o_fin'])
  })

  it('keeps the package’s own layer when scoring the others fails', async () => {
    suggestMock.mockRejectedValue(new Error('No scores'))
    render(<Picker match={SAME_ENV} />)
    await waitFor(() => expect(changes).toEqual(['o_own']))
    fireEvent.click(screen.getByRole('button', { name: 'Choose another semantic layer' }))
    expect(await screen.findByText('No scores')).toBeInTheDocument()
    expect(screen.getByText('Chosen')).toBeInTheDocument()
    expect(changes).toEqual(['o_own'])
  })
})

describe('creating a layer from the package', () => {
  it('saves the suggestion as a draft and chooses it', async () => {
    suggestMock.mockResolvedValue({ suggested: SUGGESTED, matchingOntologies: [score('o_ops', 'Operations', 0)], mergedVariants: {} })
    createMock.mockResolvedValue(layer('o_new', 'Lineage Schema', { isPublished: false }))
    render(<Picker match={ELSEWHERE} />)
    fireEvent.click(await screen.findByRole('button', { name: /Create from this package/ }))

    await waitFor(() => expect(changes).toEqual(['o_new']))
    expect(createMock).toHaveBeenCalledWith({ ...SUGGESTED, name: 'Lineage Schema' })
    expect(screen.getByText(/“Lineage Schema” was created as a draft/)).toBeInTheDocument()
    expect(screen.getByText('DRAFT')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create from this package/ })).not.toBeInTheDocument()
  })

  it('says why it couldn’t be created', async () => {
    suggestMock.mockResolvedValue({ suggested: SUGGESTED, matchingOntologies: [], mergedVariants: {} })
    createMock.mockRejectedValue(new Error('You may not create semantic layers.'))
    render(<Picker match={ELSEWHERE} />)
    fireEvent.click(await screen.findByRole('button', { name: /Create from this package/ }))
    expect(await screen.findByText('You may not create semantic layers.')).toBeInTheDocument()
    expect(changes).toEqual([])
  })
})
