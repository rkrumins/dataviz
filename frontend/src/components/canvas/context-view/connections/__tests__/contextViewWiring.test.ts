/**
 * The Connections panel's wiring into the Context View canvas.
 *
 * This class of wiring cannot be reached in jsdom without mounting the whole
 * 5k-line canvas, so it is pinned at the source level — the same idiom as
 * `noBackdropFilterInScrollers.test.ts`. Three tight assertions guard the
 * three things a future edit could silently undo: that the panel is what is
 * mounted, that it still lives inside the band-reserving wrapper (or the
 * bottom row of every column slides under it), and that its highlight goes
 * to the overlay ONLY — routing it to the columns as well would dim every
 * card on the board, because the panel carries no node set.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(__dirname, '../../ContextViewCanvas.tsx'), 'utf8')

describe('the Connections panel is wired into the Context View', () => {
  it('the Context View mounts ConnectionsPanel and no longer mounts EdgeLegend', () => {
    expect(source).toContain('<ConnectionsPanel')
    expect(source).not.toMatch(/<EdgeLegend/)
    expect(source).not.toMatch(/from '\.\.\/EdgeLegend'/)
  })

  it('the panel stays inside the band-reserving wrapper', () => {
    expect(source).toContain(
      "useBandReservation(edgeLegendRef, '--edge-legend-height', measureLegendHeader)"
    )
    const wrapperStart = source.indexOf('ref={edgeLegendRef}')
    expect(wrapperStart).toBeGreaterThan(-1)
    const wrapperBlock = source.slice(wrapperStart, source.indexOf('</div>', wrapperStart))
    expect(wrapperBlock).toContain('<ConnectionsPanel')
  })

  it('the panel is keyed by view, and its type resolver hands over a description', () => {
    // A pinned highlight or an opened panel must not survive a view switch.
    expect(source).toContain('key={connectionsViewId}')
    // getEdgeTypeDefinition fabricates prose when the ontology has none; the
    // resolver overrides it so the panel prints the schema's words or none.
    // The RULE, not its formatting: the schema's own description, and an
    // empty string — never a sentence nobody wrote — when it has none.
    expect(source).toMatch(
      /getEdgeTypeFromSchema\([^)]*\)\?\.description\s*\|\|\s*''/
    )
  })

  it('the adaptive budget culls by the weight a line stands for', () => {
    // The projection stamps the real underlying-relationship count on
    // `edgeCount`; this is where that number earns its keep. Ranking on
    // anything else (member count, insertion order) puts a rollup summarising
    // thousands of flows at the bottom of the cull list.
    expect(source).toMatch(/\(b\.edgeCount \|\| 1\) - \(a\.edgeCount \|\| 1\)/)
    expect(source).toMatch(/\.sort\(bySignificance\)\.slice\(0, autoStubThreshold\)/)
  })

  it('the panel highlight reaches the overlay only — cards keep their own highlight', () => {
    expect(source).toContain(
      'isHighlightActive={connectionHighlight !== null || isHighlightActive}'
    )
    expect(source).toMatch(/isHighlightActive=\{isHighlightActive\}/)
  })
})

/**
 * The canvas's own copy, held to the same rule the panel is.
 *
 * The discriminator is the SOURCE of each number, not the word that happens
 * to be next to it:
 *   - `aggregatedEdges` are AGGREGATED lineage rollups → flows;
 *   - `useCanvasStore.edges` is the RAW fetch, the very set `lineageEdges`
 *     filters `isContainmentEdge` out of, so it carries structural edges →
 *     the covering word, "relationships", and never "flow";
 *   - the frame pill counts distinct neighbour NODE IDS → entities, which
 *     is neither.
 */
describe('the Context View canvas names the kind of thing it is counting', () => {
  it('summarising rollups is about flows — that stream is lineage-only', () => {
    expect(source).toContain("'Summarising flows…'")
    expect(source).not.toContain("'Summarising connections…'")
  })

  it('the raw edge fetch says "relationships" — it carries structural edges too', () => {
    expect(source).toContain("'Loading relationships…'")
    expect(source).toContain('Some relationships could not be loaded')
    expect(source).toContain('Showing the largest relationships')
    expect(source).not.toContain("'Loading connections…'")
    expect(source).not.toContain('Some connections could not be loaded')
    expect(source).not.toContain('Showing the largest connections')
  })

  it('a raw-edge count is never called a flow', () => {
    // The one place the hard boundary could be crossed by accident: these
    // banners sit beside lineage copy and read as if they belonged to it.
    expect(source).not.toContain('Loading flows…')
    expect(source).not.toContain('Some flows could not be loaded')
  })

  it('the frame pill counts entities, because that is what it counts', () => {
    // `framePill.neighborIds` is a Set of node ids and `framedContext.count`
    // is its size — distinct entities, not relationships of any kind.
    expect(source).toMatch(/entit\{framePill\.offCount === 1 \? 'y' : 'ies'\}/)
    expect(source).toMatch(/entit\{framedContext\.count === 1 \? 'y' : 'ies'\}/)
    expect(source).not.toMatch(/connection\{framePill\.offCount/)
    expect(source).not.toMatch(/connection\{framedContext\.count/)
  })
})
