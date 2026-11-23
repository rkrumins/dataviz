/**
 * A search still shaping the real canvas, its panel closed, says so — in the
 * status stack — and every way out of it works: the chip's Clear, the
 * header's ×, and Esc with nothing else open.
 */
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useSearchStore } from '@/store/searchStore'

/** What a finished search publishes to the canvas: its matches, in order. */
const publish = (urns: string[]) => act(() => {
  useSearchStore.setState({
    viewId: 'harness-view',
    matchUrnSet: new Set(urns),
    orderedMatchUrns: urns,
    focusedMatchIndex: null,
  } as never)
})
const chip = () => screen.queryByRole('status', { name: 'A search is shaping the canvas' })

afterEach(() => {
  useSearchStore.setState({ matchUrnSet: new Set(), orderedMatchUrns: [], canvasFilterMode: 'highlight' } as never)
})

describe('the search chip on the canvas', () => {
  it('appears for a search left on the canvas, says when rows are hidden, and Clear ends it', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    expect(chip()).toBeNull()

    publish(['orders', 'aov'])
    await h.settle()
    expect(chip()).toHaveTextContent('Highlighting 2 search matches')
    // The header's × is there too, though nothing was typed in its box.
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument()

    act(() => { useSearchStore.setState({ canvasFilterMode: 'isolate' } as never) })
    await h.settle()
    expect(chip()).toHaveTextContent('Showing only 2 search matches')
    expect(chip()).toHaveTextContent('Rows that don’t match are hidden from the canvas.')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Clear$/ })) })
    await h.settle()
    expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
    expect(chip()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  }, 30000)

  it('steps aside while the search panel is open', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    publish(['orders'])
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Open search/ })) })
    await h.settle()
    expect(chip()).toBeNull()
    expect(useSearchStore.getState().matchUrnSet.size).toBe(1)
  }, 30000)

  it('Esc with nothing open or held clears it; with a selection, Esc lets go of that first', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    publish(['orders'])
    await h.settle()
    await h.clickCard('tableau')
    h.pressEscape()
    await h.settle()
    // The selection went; the search stayed.
    expect(useSearchStore.getState().matchUrnSet.size).toBe(1)

    h.pressEscape()
    await h.settle()
    expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
    expect(chip()).toBeNull()
  }, 30000)
})
