/**
 * A Connections search's matches on the real canvas: the lines that draw
 * them light, each with how many matches it draws (a "+" while pages of
 * them remain), and the rest dim — drawn even On Hover, the default, which
 * draws no other line until one is hovered. A selection's highlight comes
 * first; a search of another view, or a trace, lights nothing.
 *
 * jsdom gives every row the same box, so the overlay never draws a line;
 * what the canvas hands the overlay is read instead.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { type MatchedEdge, useSearchStore } from '@/store/searchStore'

const overlay = vi.hoisted(() => ({
  lines: [] as Array<{ id: string; source: string; target: string }>,
  highlighted: undefined as Set<string> | undefined,
  active: false,
  labels: undefined as ReadonlyMap<string, string> | undefined,
}))
vi.mock('../LineageFlowOverlay', async (original) => {
  const real = await original<typeof import('../LineageFlowOverlay')>()
  return {
    ...real,
    LineageFlowOverlay: (props: Parameters<typeof real.LineageFlowOverlay>[0]) => {
      overlay.lines = props.edges
      overlay.highlighted = props.highlightedEdges
      overlay.active = props.isHighlightActive ?? false
      overlay.labels = props.countLabels
      return <real.LineageFlowOverlay {...props} />
    },
  }
})

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  useSearchStore.getState().clear()
})

const flow = (source: string, target: string) => ({
  id: `f:${source}>${target}`, source, target, type: 'lineage',
  data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
})

const match = (source: string, target: string): MatchedEdge => ({
  key: `${source}|TRANSFORMS|${target}`, id: `f:${source}>${target}`, source, target, edgeType: 'TRANSFORMS',
  sourceChain: [], targetChain: [],
})

async function openView() {
  const estate = anchoredPortsEstate()
  const h = await renderCanvasWithTrace(estate, {
    focus: 'SRC.raw_orders',
    browseHolds: estate.model.nodes.map(n => n.urn),
    ancestorChains: true,
  })
  act(() => {
    useCanvasStore.getState().addGraph([], [flow('s2', 'dash'), flow('s1', 'rpt')] as never)
  })
  await h.settle()
  return h
}

function search(matches: MatchedEdge[], { viewId = 'harness-view', complete = true } = {}) {
  act(() => {
    useSearchStore.getState().setResult({
      viewId,
      matchUrns: matches.flatMap(m => [m.source, m.target]),
      edgeKeys: matches.map(m => m.key),
      matchedEdges: matches,
      matchedEdgesComplete: complete,
      ancestorPaths: [],
      queryHash: 'q',
    })
  })
}

const lineOf = (source: string, target: string) => overlay.lines.find(l => l.source === source && l.target === target)?.id

describe('a Connections search on the canvas', () => {
  it('draws and lights the lines its matches are drawn on, each with how many it draws', async () => {
    await openView()
    expect(overlay.lines).toEqual([])
    search([match('s2', 'dash')])
    await waitFor(() => expect(overlay.active).toBe(true), { timeout: 8000 })
    const lit = lineOf('s2', 'dash')!
    expect(overlay.lines.map(l => l.id)).toEqual([lit])
    expect([...overlay.highlighted!]).toEqual([lit])
    expect([...overlay.labels!]).toEqual([[lit, '1']])
  })

  it('says "at least" while pages of matches remain', async () => {
    await openView()
    search([match('s2', 'dash')], { complete: false })
    await waitFor(() => expect(overlay.labels?.get(lineOf('s2', 'dash')!)).toBe('1+'), { timeout: 8000 })
  })

  it("gives way to a selection's highlight", async () => {
    await openView()
    search([match('s2', 'dash')])
    await waitFor(() => expect(overlay.labels).toBeDefined(), { timeout: 8000 })
    act(() => { useCanvasStore.getState().selectNode('s1') })
    await waitFor(() => expect(overlay.labels).toBeUndefined())
    expect(overlay.highlighted?.has(lineOf('s1', 'rpt')!)).toBe(true)
    expect(overlay.highlighted?.has(lineOf('s2', 'dash')!)).toBe(false)
  })

  it("lights nothing for another view's search", async () => {
    await openView()
    search([match('s2', 'dash')], { viewId: 'another-view' })
    await new Promise(r => setTimeout(r, 50))
    expect(overlay.active).toBe(false)
    expect(overlay.labels).toBeUndefined()
    expect(overlay.lines).toEqual([])
  })

  it('lights nothing during a trace', async () => {
    const h = await openView()
    search([match('s2', 'dash')])
    await waitFor(() => expect(overlay.labels).toBeDefined(), { timeout: 8000 })
    await h.startTrace('SRC.raw_orders')
    await waitFor(() => expect(overlay.labels).toBeUndefined())
  })
})
