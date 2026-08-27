/**
 * Find-in-view, against the real canvas.
 *
 * The unit tests mock the pieces; these mount `ContextViewCanvas` and drive
 * the actual field, because the two failures this feature has had were both
 * invisible to jsdom-free reasoning:
 *
 *   - the results panel rendered inside an `overflow-hidden` ancestor and was
 *     clipped to nothing, so the search looked completely dead;
 *   - and the thing a user notices first is not the panel but the canvas
 *     lighting up, which travels through a different path entirely (the
 *     search store, not the panel's own state).
 *
 * So: typing must light the canvas, and it must never write to the canvas
 * store — the invariant the per-node child search this replaced violated.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useSearchStore } from '@/store/searchStore'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'


describe('find-in-view on the real canvas', () => {
    beforeEach(() => { useSearchStore.getState().clear() })

    it('lights the canvas for a term that exists', async () => {
        const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
        expect(h.visibleCardIds()).toContain('tableau')

        expect(await h.typeInFind('tableau')).toBe(true)

        // The publish is debounced — this is the path that drives the
        // spotlight, the isolate/exclude filter and the roll-up badges.
        await waitFor(() => {
            expect(useSearchStore.getState().matchUrnSet.size).toBeGreaterThan(0)
        })
        expect(useSearchStore.getState().resultSource).toBe('quick')
        expect(h.consoleErrors()).toEqual([])
    }, 30000)

    it('opens its results panel outside the clipped header subtree', async () => {
        const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
        expect(await h.typeInFind('tableau')).toBe(true)

        const panel = await screen.findByRole('dialog', { name: /search results/i })
        // The header lives inside `overflow-hidden` flex containers. A panel
        // nested in there is rendered and then clipped away — which is
        // exactly how this shipped broken. What matters is that it is
        // outside every one of those ancestors, not its exact depth in the
        // portal wrapper.
        expect(panel.closest('[data-tour="canvas-search"]')).toBeNull()
        expect(panel.closest('[data-canvas-body]')).toBeNull()
        expect(document.body.contains(panel)).toBe(true)
        expect(h.consoleErrors()).toEqual([])
    }, 30000)

    it('takes the spotlight back off when the query is cleared', async () => {
        const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
        expect(await h.typeInFind('tableau')).toBe(true)
        await waitFor(() => {
            expect(useSearchStore.getState().matchUrnSet.size).toBeGreaterThan(0)
        })

        await act(async () => {
            fireEvent.click(screen.getByLabelText('Clear search'))
        })
        await h.settle()

        await waitFor(() => {
            expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
        })
    }, 30000)

    it('finds nothing for a term that is not there, and says so', async () => {
        const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
        expect(await h.typeInFind('zzz_not_here')).toBe(true)

        const panel = await screen.findByRole('dialog', { name: /search results/i })
        await waitFor(() => {
            expect(panel.textContent).toContain('No match for')
        })
        expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
    }, 30000)

    it('reaches Advanced Search without opening the panel first', async () => {
        const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Advanced Search/i }))
        })
        await h.settle()
        expect(await screen.findByTestId('search-map-panel')).toBeInTheDocument()
    }, 30000)

    it('never writes to the canvas store while searching', async () => {
        const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
        const before = h.snapshotStore()
        expect(await h.typeInFind('tableau')).toBe(true)
        await waitFor(() => {
            expect(useSearchStore.getState().matchUrnSet.size).toBeGreaterThan(0)
        })
        expect(h.storeWrites()).toBe(0)
        expect(h.snapshotStore()).toEqual(before)
    }, 30000)
})
