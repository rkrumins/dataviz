/**
 * SOLID BY DEFAULT, HOLLOW ONLY WHEN THE CANVAS KNOWS — on the real canvas.
 *
 * A card with lineage in a direction shows it, solid, on the conventional
 * side (incoming left, outgoing right) until the canvas has CONFIRMED that
 * every partner that way is outside the view: only then is it hollow, and
 * only then does a curated view's dashed cue, or the "Selected: … outside
 * this view" chip, say so. "Counted, but no line drawn" is not that: the
 * partner may be a row past a page, a child of the card itself, a member of
 * the same group, or a row drawn in another column.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate, groupedEstate, splitChildEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

/** `kind:dir` of the card's port on each side, or null for no port. */
function ports(id: string): { left: string | null; right: string | null } {
  const at = (side: 'left' | 'right') => {
    const el = document.getElementById(`layer-node-${id}`)?.querySelector<HTMLElement>(`[data-lineage-port="${side}"]`)
    return el ? `${el.dataset.port}:${el.dataset.dir}` : null
  }
  return { left: at('left'), right: at('right') }
}

/** The card's dashed "… lead outside this view" cues. */
function cues(id: string): string[] {
  const card = document.getElementById(`layer-node-${id}`)
  return [...(card?.querySelectorAll<HTMLElement>('[title]') ?? [])]
    .map(el => el.getAttribute('title') ?? '')
    .filter(title => /outside this view/.test(title))
}

/** The "Selected: N↑ M↓ outside this view" chip's text, or null. */
function selectedChip(): string | null {
  const chip = [...document.querySelectorAll('span')].find(el => el.textContent?.startsWith('Selected:'))
  return chip?.textContent ?? null
}

/** Let the totals, the chains and the roll-ups land. */
async function settled(h: { settle(): Promise<void> }) {
  await h.settle()
  await act(async () => { await new Promise(r => setTimeout(r, 2500)) })
  await h.settle()
}

const flow = (source: string, target: string) => ({
  id: `f:${source}>${target}`, source, target, type: 'lineage',
  data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
})

// s9 is a row of Staging past its loaded page; `far` is held by nothing.
const holds = () => anchoredPortsEstate().model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far')

describe('a curated anchored view: in view is never "outside"', () => {
  it("a partner past another column's page: solid facing it, no outside cue, no outside chip", async () => {
    const h = await renderCanvasWithTrace(anchoredPortsEstate(), {
      focus: 'SRC.raw_orders',
      browseHolds: holds(),
      ancestorChains: true,
      nodeDegrees: { rpt: { in: 1, out: 0 } },
      // s9 → rpt, known to the server as Staging's anchor → rpt. No flow is
      // served: the row's own read can come back without it.
      aggregatedCells: [{ sourceUrn: 'STG', targetUrn: 'rpt' }],
    })
    await waitFor(() => {
      expect(ports('rpt')).toEqual({ left: 'here:in', right: null })
    }, { timeout: 8000 })
    await settled(h)
    expect(cues('rpt')).toEqual([])

    act(() => { useCanvasStore.getState().selectNode('rpt') })
    await settled(h)
    expect(selectedChip()).toBeNull()
  }, 30_000)

  it('lineage the canvas placed outside the view still says so, on the cue and the chip', async () => {
    await renderCanvasWithTrace(anchoredPortsEstate(), {
      focus: 'SRC.raw_orders',
      browseHolds: holds(),
      ancestorChains: true,
      nodeDegrees: { dash: { in: 1, out: 0 } },
    })
    act(() => { useCanvasStore.getState().addGraph([], [flow('far', 'dash')] as never) })
    await waitFor(() => {
      expect(ports('dash')).toEqual({ left: 'beyond:in', right: null })
      expect(cues('dash')).toHaveLength(1)
    }, { timeout: 8000 })
    expect(cues('dash')[0]).toMatch(/^1 incoming underlying flow lead outside this view/)

    act(() => { useCanvasStore.getState().selectNode('dash') })
    await waitFor(() => {
      expect(selectedChip()).toMatch(/Selected: 1↑ 0↓ outside this view/)
    }, { timeout: 8000 })
  }, 30_000)

  it("a partner in the row's own column, past its page: solid on the conventional side, no cue", async () => {
    const h = await renderCanvasWithTrace(anchoredPortsEstate(), {
      focus: 'SRC.raw_orders',
      browseHolds: holds(),
      ancestorChains: true,
      nodeDegrees: { s2: { in: 0, out: 1 } },
      flows: [{ sourceUrn: 's2', targetUrn: 's9' }],
      // The row against its own anchor: the row summarised against itself.
      aggregatedCells: [{ sourceUrn: 's2', targetUrn: 'STG' }],
    })
    await waitFor(() => {
      expect(ports('s2')).toEqual({ left: null, right: 'lineage:out' })
    }, { timeout: 8000 })
    await settled(h)
    expect(ports('s2')).toEqual({ left: null, right: 'lineage:out' })
    expect(cues('s2')).toEqual([])
  }, 30_000)
})

describe('lineage that stays inside what the card stands for', () => {
  it('a closed container whose lineage runs between its own rows is solid both ways', async () => {
    const h = await renderCanvasWithTrace(anchoredPortsEstate(), {
      focus: 'SRC.raw_orders',
      browseHolds: holds(),
      ancestorChains: true,
      nodeDegrees: {
        // No flow of its own; its roll-up cells run to its own rows.
        'SRC.DB_A': { in: 0, out: 0, rollupIn: 1, rollupOut: 1 },
        'SRC.DB_B.t2': { in: 0, out: 1 },
      },
    })
    await waitFor(() => {
      expect(ports('SRC.DB_A')).toEqual({ left: 'lineage:in', right: 'lineage:out' })
    }, { timeout: 8000 })
    await settled(h)
    expect(ports('SRC.DB_A')).toEqual({ left: 'lineage:in', right: 'lineage:out' })
    expect(cues('SRC.DB_A')).toEqual([])

    // A row one level down follows the same rule; the open container
    // above it, with no lineage of its own, leaves that to it.
    await h.toggle('SRC.DB_B')
    await waitFor(() => {
      expect(ports('SRC.DB_B.t2')).toEqual({ left: null, right: 'lineage:out' })
    }, { timeout: 8000 })
    expect(ports('SRC.DB_B')).toEqual({ left: null, right: null })
  }, 30_000)

  it('a closed logical group whose members reach only each other is solid both ways', async () => {
    const h = await renderCanvasWithTrace(groupedEstate(), {
      focus: 'solo',
      nodeDegrees: { 'g.a': { in: 0, out: 1 }, 'g.b': { in: 1, out: 0 } },
    })
    act(() => { useCanvasStore.getState().addGraph([], [flow('g.a', 'g.b')] as never) })
    await waitFor(() => {
      expect(ports('g.a')).toEqual({ left: 'here:out', right: null })
    }, { timeout: 8000 })

    await h.toggle('logical:grp')
    await waitFor(() => {
      expect(ports('logical:grp')).toEqual({ left: 'lineage:in', right: 'lineage:out' })
    }, { timeout: 8000 })
    expect(ports('solo')).toEqual({ left: null, right: null })
  }, 30_000)

  it('a closed container whose lineage runs through a child drawn in another column is solid', async () => {
    const h = await renderCanvasWithTrace(splitChildEstate(), {
      focus: 'R',
      ancestorChains: true,
      nodeDegrees: { P: { in: 0, out: 0, rollupIn: 0, rollupOut: 1 }, 'P.C': { in: 0, out: 1 }, R: { in: 1, out: 0 } },
      aggregatedCells: [{ sourceUrn: 'P', targetUrn: 'R' }, { sourceUrn: 'P.C', targetUrn: 'R' }],
      flows: [{ sourceUrn: 'P.C', targetUrn: 'R' }],
    })
    await waitFor(() => {
      expect(ports('P.C')).toEqual({ left: 'here:out', right: null })
      expect(ports('R')).toEqual({ left: 'here:in', right: null })
      expect(ports('P')).toEqual({ left: null, right: 'lineage:out' })
    }, { timeout: 8000 })
    await settled(h)
    expect(ports('P')).toEqual({ left: null, right: 'lineage:out' })
  }, 30_000)
})
