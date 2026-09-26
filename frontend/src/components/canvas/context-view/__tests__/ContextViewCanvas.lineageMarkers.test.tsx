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
import { anchoredPortsEstate } from '@/test/fixtures/traceEstates'
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
})
