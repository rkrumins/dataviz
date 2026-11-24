/**
 * A search still shaping the real canvas says so in the header's search box —
 * not in the status stack over the columns, where it covered layer headers and
 * rows for as long as it stood — and every way out of it works: the token's ×,
 * its card's Clear, and Esc with nothing else open.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
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
const token = () => screen.queryByRole('group', { name: 'Search on the canvas' })
const stack = () => document.querySelector('[data-canvas-status-stack]') as HTMLElement

afterEach(() => {
  useSearchStore.setState({ matchUrnSet: new Set(), orderedMatchUrns: [], canvasFilterMode: 'highlight' } as never)
})

describe('a search on the canvas, said in the header box', () => {
  it('appears in the box, not over the columns, says when rows are hidden, and its × ends it', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    expect(token()).toBeNull()

    publish(['orders', 'aov'])
    await h.settle()
    expect(token()).toHaveTextContent('Highlighting 2 matches')
    expect(token()!.closest('[data-tour="canvas-search"]')).not.toBeNull()
    expect(stack()).not.toHaveTextContent(/search/i)

    act(() => { useSearchStore.setState({ canvasFilterMode: 'isolate' } as never) })
    await h.settle()
    expect(token()).toHaveTextContent('Showing only 2 matches')

    await act(async () => { fireEvent.click(within(token()!).getByRole('button', { name: 'Clear search' })) })
    await h.settle()
    expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
    expect(token()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  }, 30000)

  it('stays in the box while the panel is open, and leaves stepping to the panel', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    publish(['orders'])
    await h.settle()
    expect(within(token()!).getByRole('button', { name: 'Next match' })).toBeInTheDocument()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit this search' })) })
    await h.settle()
    expect(token()).toHaveTextContent('Highlighting 1 match')
    expect(within(token()!).queryByRole('button', { name: 'Next match' })).toBeNull()
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
    expect(token()).toBeNull()
  }, 30000)
})
