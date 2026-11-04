/**
 * Lines that point back: a line whose source sits in a layer to the RIGHT of
 * its target runs against the order of the view's layers. Where the reader
 * turns highlighting on (Display → Highlight lines that point back), such a
 * line is drawn in the alert colour and marked `data-edge-back`; a line that
 * flows with the layers never is. Off — the default — nothing is marked.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { act } from '@testing-library/react'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

/** The drawn line from one card to another. */
const lineBetween = (source: string, target: string) =>
  [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')]
    .find(g => g.getAttribute('data-edge-src') === source && g.getAttribute('data-edge-tgt') === target) ?? null

/** Warehouse (left) → Report (right) forward, and Report → Warehouse back. */
async function forwardAndBack() {
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
  act(() => {
    useCanvasStore.getState().addEdges([
      { id: 'forward', source: 'INTERMEDIATE_T2', target: 'tableau', data: { edgeType: 'FLOWS_TO' } },
      { id: 'back', source: 'tableau', target: 'REPORTING', data: { edgeType: 'FLOWS_TO' } },
    ] as LineageEdge[])
  })
  await h.settle()
  await h.clickCard('tableau')
  await h.settle()
  return h
}

describe('lines that point back', () => {
  beforeEach(() => usePreferencesStore.setState({ lineageRenderMode: 'raw', highlightBackPointers: false, backPointerColor: '#ef4444' }))

  it('are marked where the reader turned highlighting on — and only they are', async () => {
    usePreferencesStore.setState({ highlightBackPointers: true })
    await forwardAndBack()
    expect(lineBetween('tableau', 'REPORTING')).toHaveAttribute('data-edge-back')
    expect(lineBetween('INTERMEDIATE_T2', 'tableau')).not.toHaveAttribute('data-edge-back')
  })

  it('are not marked while highlighting is off', async () => {
    await forwardAndBack()
    expect(lineBetween('tableau', 'REPORTING')).not.toBeNull()
    expect(lineBetween('tableau', 'REPORTING')).not.toHaveAttribute('data-edge-back')
  })
})
