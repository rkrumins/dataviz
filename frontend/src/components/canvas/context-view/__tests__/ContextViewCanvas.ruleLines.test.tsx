/**
 * The view's relationship display rules paint the Context View's lines, as they do the Graph
 * canvas's: a line drawing a relationship a rule matches takes the rule's colour, and its chips
 * show where the reader is looking — on the lines of the selected card, and in a hovered line's
 * card. Lines no rule matches keep their type's colour; a trace keeps its own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import { usePreferencesStore } from '@/store/preferences'
import type { DisplayRuleConfig } from '@/types/schema'

const engine = vi.hoisted(() => ({ calls: [] as Array<[string | null, { lines?: boolean } | undefined]> }))

// The engine asks the server; here the store is seeded with what it would have answered.
vi.mock('@/hooks/useDisplayRuleEngine', () => ({
  useDisplayRuleEngine: (viewId: string | null, options?: { lines?: boolean }) => {
    engine.calls.push([viewId, options])
  },
}))

const RULE: DisplayRuleConfig = {
  id: 'feeds-reports', name: 'Feeds reports', color: '#e11d48', enabled: true, target: 'relationships',
  predicate: { kind: 'edges', edgeTypes: ['FLOWS_TO'] }, style: { dash: 'dashed', width: 3 },
  createdAt: '2026-01-01T00:00:00Z',
}

/** The drawn line from one card to another. */
const lineBetween = (source: string, target: string) =>
  [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')]
    .find(g => g.getAttribute('data-edge-src') === source && g.getAttribute('data-edge-tgt') === target) ?? null

/** Warehouse → Report (matched by the rule) and Report → Warehouse (not). */
async function twoLines() {
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
  act(() => {
    useCanvasStore.getState().addEdges([
      { id: 'forward', source: 'INTERMEDIATE_T2', target: 'tableau', data: { edgeType: 'FLOWS_TO' } },
      { id: 'back', source: 'tableau', target: 'REPORTING', data: { edgeType: 'FLOWS_TO' } },
    ] as LineageEdge[])
    const store = useDisplayRuleMatchStore.getState()
    store.setRuleMeta([RULE])
    store.applyEdgeMembership([RULE.id], ['forward', 'back'], { [RULE.id]: ['forward'] })
  })
  await h.settle()
  return h
}

describe('relationship display rules on the Context View', () => {
  beforeEach(() => {
    engine.calls = []
    useDisplayRuleMatchStore.getState().clear()
    usePreferencesStore.setState({ lineageRenderMode: 'raw', highlightBackPointers: false })
  })

  it('asks which relationships the rules match, for the lines it draws', async () => {
    await twoLines()
    expect(engine.calls.length).toBeGreaterThan(0)
    expect(engine.calls.every(([, options]) => options?.lines === true)).toBe(true)
  })

  it('paints a line drawing a matched relationship in the rule’s colour; the rest keep theirs', async () => {
    const h = await twoLines()
    await h.clickCard('tableau')
    await h.settle()
    const painted = lineBetween('INTERMEDIATE_T2', 'tableau')!
    const plain = lineBetween('tableau', 'REPORTING')!
    expect(painted).toHaveAttribute('data-edge-rule', RULE.color)
    expect(painted.querySelector('circle')).toHaveAttribute('fill', RULE.color)
    expect(plain).not.toHaveAttribute('data-edge-rule')
    expect(plain.querySelector('circle')?.getAttribute('fill')).not.toBe(RULE.color)
  })

  it('shows the rule’s chips on the selected card’s lines only', async () => {
    const h = await twoLines()
    expect(document.querySelector('[data-testid="rule-line-chips"]')).toBeNull()
    await h.clickCard('tableau')
    await h.settle()
    const chipsOf = (g: SVGGElement) =>
      document.querySelector(`[data-testid="rule-line-chips"][data-line-id="${g.getAttribute('data-edge-id')}"]`)
    expect(chipsOf(lineBetween('INTERMEDIATE_T2', 'tableau')!)).toHaveTextContent('Feeds reports')
    expect(chipsOf(lineBetween('tableau', 'REPORTING')!)).toBeNull()
    expect(document.querySelectorAll('[data-testid="rule-line-chips"]')).toHaveLength(1)
  })

  it('names the rules that style a hovered line in its card — on that line only', async () => {
    const h = await twoLines()
    await h.clickCard('tableau')
    await h.settle()
    const hits = [...document.querySelectorAll<SVGPathElement>('path[data-canvas-interactive]')]
    expect(hits).toHaveLength(2)
    const named: string[] = []
    for (const hit of hits) {
      await act(async () => {
        fireEvent.mouseEnter(hit, { clientX: 300, clientY: 300 })
        fireEvent.mouseMove(hit, { clientX: 302, clientY: 302 })
      })
      await h.settle()
      const card = document.querySelector('[data-testid="line-hover-rules"]')
      if (card) named.push(card.textContent ?? '')
      await act(async () => { fireEvent.mouseLeave(hit) })
      await h.settle()
    }
    expect(named).toHaveLength(1)
    expect(named[0]).toMatch(/Styled by/)
    expect(named[0]).toMatch(/Feeds reports/)
  })

  it('leaves a trace’s lines to the trace', async () => {
    const h = await twoLines()
    await h.startTrace('tableau')
    await h.resolveTrace()
    await h.settle()
    expect(document.querySelector('g[data-edge-rule]')).toBeNull()
  })
})
