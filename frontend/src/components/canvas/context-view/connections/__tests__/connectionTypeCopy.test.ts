/**
 * The Connections panel prints a description under every type it lists, and
 * it is the surface where a system type's wording is read most closely.
 *
 * The panel's resolver deliberately replaces the fabricated prose that
 * `getEdgeTypeDefinition` invents with the schema's own words — but the
 * system type IS in the resolved ontology (seeded per data source, injected
 * on read), so that override handed back the engineer-speak sentence and
 * discarded the plain-English copy the definition had just applied. The copy
 * must win; the schema's words remain the fallback for every other type.
 *
 * Pinned at the source level for the same reason as `contextViewWiring`:
 * the resolver cannot be reached in jsdom without mounting the whole canvas.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../ContextViewCanvas.tsx'), 'utf8')

describe("the Connections panel's type resolver keeps the plain-English copy", () => {
  it('prefers edgeTypeCopy over the ontology description', () => {
    expect(source).toMatch(
      /edgeTypeCopy\([^)]*\)\?\.description\s*\?\?\s*\(?\s*getEdgeTypeFromSchema/
    )
  })

  it('still falls back to the schema words, or none at all', () => {
    expect(source).toMatch(
      /getEdgeTypeFromSchema\([^)]*\)\?\.description\s*\|\|\s*''/
    )
  })
})
