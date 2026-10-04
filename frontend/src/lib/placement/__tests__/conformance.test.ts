/**
 * The shared placement corpus, run against the TypeScript twin.
 *
 * backend/tests/fixtures/placement/*.json pins what the one placement
 * contract answers for whole views; backend/tests/test_placement_conformance.py
 * runs the same files against the Python reference, so the canvas and the
 * server cannot drift apart without a red build on both sides. Each case runs
 * as given and with its nodes and edges reversed; some also pin the
 * write-path policy (suggest).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { GraphNode } from '@/providers/GraphDataProvider'
import { OPERATOR_TABLE } from '@/types/generated/searchOperators'

import { compilePlacementSpec, factsFromGraphNode, placeAll, suggestPlacement, type PlacementResult } from '../placement'

const REPO = resolve(__dirname, '../../../../..')
const CORPUS = join(REPO, 'backend/tests/fixtures/placement')

interface CorpusNode {
  urn: string
  entityType?: string
  displayName?: string
  tags?: string[]
  layerAssignment?: string
  properties?: Record<string, unknown>
}

interface CorpusCase {
  name: string
  view: unknown
  ontology?: { containment: Record<string, string | null> }
  nodes: CorpusNode[]
  edges?: { source: string; target: string; edgeType: string }[]
  context?: { createdInBranch?: string[] }
  expect: Record<string, Record<string, unknown>>
  suggest?: { urn: string; chosenLayerId?: string; defaultLayerId?: string; expect: { layerId: string | null; pin: boolean } }[]
}

const CASES: CorpusCase[] = readdirSync(CORPUS).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => (JSON.parse(readFileSync(join(CORPUS, f), 'utf-8')) as { cases: CorpusCase[] }).cases)

/** view_placement.child_is_source: whether a containment edge points child -> parent. */
function childIsSource(edgeType: string, direction: string | null): boolean {
  if (direction === 'target-to-source' || direction === 'child-to-parent') return true
  if (direction === 'parent-to-child') return false
  return edgeType.toUpperCase() === 'BELONGS_TO'
}

function run(c: CorpusCase, reversed = false) {
  const nodes = reversed ? [...c.nodes].reverse() : c.nodes
  const edges = reversed ? [...(c.edges ?? [])].reverse() : c.edges ?? []
  const spec = compilePlacementSpec(c.view)
  const facts = new Map(nodes.map((n) => [n.urn, factsFromGraphNode({
    urn: n.urn, entityType: n.entityType ?? '', displayName: n.displayName ?? n.urn, tags: n.tags ?? [],
    layerAssignment: n.layerAssignment, properties: n.properties ?? {},
  } as GraphNode)]))
  const containment = new Map(Object.entries(c.ontology?.containment ?? {})
    .map(([type, direction]) => [type.toUpperCase(), childIsSource(type, direction)]))
  const parents = new Map<string, string[]>()
  for (const e of edges) {
    const isSource = containment.get(e.edgeType.toUpperCase())
    if (isSource === undefined) continue
    const [child, parent] = isSource ? [e.source, e.target] : [e.target, e.source]
    parents.set(child, [...(parents.get(child) ?? []), parent])
  }
  const placed = placeAll(spec, facts.keys(), (u) => facts.get(u) ?? null, (u) => parents.get(u) ?? [],
    new Set(c.context?.createdInBranch ?? []))
  return { spec, facts, placed: Object.fromEntries([...placed].map(([u, p]) => [u, output(p)])) }
}

/** The agreed output: null / undefined / false dropped, and never the internal cascade. */
function output(p: PlacementResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).filter(([k, v]) => k !== 'cascade' && v !== null && v !== undefined && v !== false))
}

describe('the shared placement corpus', () => {
  it('holds enough cases to mean something', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40)
  })

  describe.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    it('places every node as the corpus says', () => {
      expect(run(c).placed).toEqual(c.expect)
    })

    it('does not depend on load order', () => {
      expect(run(c, true).placed).toEqual(c.expect)
    })

    if (c.suggest?.length) {
      it('suggests write-path placements as the corpus says', () => {
        const { spec, facts } = run(c)
        for (const s of c.suggest ?? []) {
          const opts = { chosenLayerId: s.chosenLayerId ?? null, defaultLayerId: s.defaultLayerId ?? null }
          expect(suggestPlacement(spec, facts.get(s.urn)!, opts), JSON.stringify(s)).toEqual(s.expect)
        }
      })
    }
  })
})

describe('the operator table', () => {
  it('is the backend schema, so a rule compares the same values on both sides', () => {
    const schema: unknown = JSON.parse(readFileSync(join(REPO, 'backend/common/schema/searchoperators.v1.json'), 'utf-8'))
    expect(OPERATOR_TABLE).toEqual(schema)
  })
})
