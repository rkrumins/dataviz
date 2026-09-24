/**
 * THE SUBSET STUDIO ON THE REAL CANVAS.
 *
 * While the studio is open, a click on a card picks it rather than selecting
 * it, the rail follows the picks, the source view's own lineage is read once
 * for Grow, and the picks are previewed as a member set of their own — and
 * none of it touches the graph the canvas holds.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'
import { useSubsetStudioStore } from '@/features/view-subset/model/studioStore'

const card = (id: string) => document.getElementById(`layer-node-${id}`)!

afterEach(() => { act(() => useSubsetStudioStore.getState().close({ discard: true })) })

describe('the subset studio on the source canvas', () => {
  it('picks on click, previews the picks, and leaves the canvas graph alone', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      bridges: { connectivity: { mode: 'direct' }, links: [{ source: 'INTERMEDIATE_T2', target: 'tableau', hops: 3 }] },
    })
    const before = h.snapshotStore()
    act(() => useSubsetStudioStore.getState().open('harness-view'))
    await h.settle()

    const rail = await screen.findByRole('complementary', { name: 'Subset studio' })
    expect(rail).toBeTruthy()

    // The source view's members are read once, for Grow.
    await waitFor(() => expect(h.bridgeRequests().length).toBeGreaterThan(0), { timeout: 4000 })
    expect(h.bridgeRequests()[0].members.map(m => m.urn).sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'tableau'])

    await act(async () => { fireEvent.click(card('INTERMEDIATE_T2')) })
    await act(async () => { fireEvent.click(card('tableau')) })
    expect(useSubsetStudioStore.getState().order).toEqual(['INTERMEDIATE_T2', 'tableau'])
    // Picking is not selecting.
    expect(useCanvasStore.getState().selectedNodeIds).toEqual([])
    expect(within(rail).getByText(/2 entities · 2 layers/)).toBeTruthy()

    // Once the picks settle, they are previewed as a member set of their own.
    await waitFor(() => {
      const previews = h.bridgeRequests().filter(r => r.members.length === 2)
      expect(previews.map(r => r.members.map(m => m.urn).sort())).toContainEqual(['INTERMEDIATE_T2', 'tableau'])
    }, { timeout: 4000 })

    // Clicking a pick again takes it out.
    await act(async () => { fireEvent.click(card('tableau')) })
    expect(useSubsetStudioStore.getState().order).toEqual(['INTERMEDIATE_T2'])

    expect(h.snapshotStore()).toEqual(before)
  })

  it('shows the studio in the header, and leaving asks before discarding', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      bridges: { connectivity: { mode: 'direct' }, links: [] },
    })
    act(() => useSubsetStudioStore.getState().open('harness-view'))
    await h.settle()
    await act(async () => { fireEvent.click(card('REPORTING')) })
    expect(screen.getByText(/1 picked/)).toBeTruthy()

    const headerCancel = screen.getAllByRole('button', { name: 'Cancel' })[0]
    await act(async () => { fireEvent.click(headerCancel) })
    expect(screen.getByText('Discard 1 pick?')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })) })
    await h.settle()
    expect(useSubsetStudioStore.getState().sourceViewId).toBeNull()
    // The header's cross-fade back to its usual actions takes a moment.
    await waitFor(() => expect(screen.queryByText(/picked/)).toBeNull())
  })

  it('a click selects as usual once the studio is closed', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      bridges: { connectivity: { mode: 'direct' }, links: [] },
    })
    await act(async () => { fireEvent.click(card('REPORTING')) })
    await h.settle()
    expect(useCanvasStore.getState().selectedNodeIds).toContain('REPORTING')
    expect(useSubsetStudioStore.getState().order).toEqual([])
  })
})
