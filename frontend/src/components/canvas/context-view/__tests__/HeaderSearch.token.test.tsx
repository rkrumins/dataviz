/**
 * A search shaping the canvas, said in the header's search box — by the words
 * in it when they are the search, by a token in their place when they are not
 * — with its count, its step, its mode, the layers its matches are in, Edit
 * and Clear. Nothing of it is drawn over the canvas any more.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_QUICK } from '@/components/canvas/search/session/quickPredicate'
import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { usePersonaStore } from '@/store/persona'
import { readPersistedCanvasFilterMode, useSearchStore } from '@/store/searchStore'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'
import type { AncestorRef, SearchHit } from '@/types/search'

import { HeaderSearch } from '../header/HeaderSearch'

const anc = (name: string): AncestorRef => ({ urn: `urn:${name}`, displayName: name, entityType: 'container' })
const hit = (urn: string, ancestorPath: AncestorRef[] = []): SearchHit => ({
  node: { urn, displayName: urn, entityType: 'dataset', properties: {} },
  ancestorPath, highlights: [],
}) as unknown as SearchHit

function resultsView(result: Record<string, unknown>): PanelView {
  return { kind: 'results', query: {}, result, elapsedMs: 12 } as unknown as PanelView
}

const LAYERS = [
  { id: 'src', name: 'Sources', color: '#6366f1', order: 0, entityTypes: [] },
  { id: 'mart', name: 'Marts', color: '#10b981', order: 1, entityTypes: [] },
  { id: 'bi', name: 'Reports', color: '#f59e0b', order: 2, entityTypes: [] },
] as ViewLayerConfig[]

/** A search run from the panel: three matches, in two of the three layers. */
function fromThePanel(over: Partial<ViewSearchSession> = {}) {
  return stubSession({
    layers: LAYERS,
    resolveLayer: vi.fn((h: SearchHit) => (h.node.urn === 'c' ? 'bi' : 'src')),
    advanced: stubAdvanced({
      view: resultsView({ totalCount: 3, candidateCount: 3, truncated: false, hits: [hit('a', [anc('crm')]), hit('b'), hit('c')] }),
      runState: { hash: 'from-the-panel', status: 'done' },
    }),
    ...over,
  })
}

/** "orders", typed in the box, standing on the canvas. */
function typed(over: Partial<ViewSearchSession> = {}) {
  return fromThePanel({
    quick: { ...DEFAULT_QUICK, text: 'orders' },
    resultFromBox: true,
    resultMatchesQuick: true,
    ...over,
  })
}

/** What a finished search publishes to the canvas. */
function lit(urns = ['a', 'b', 'c']) {
  useSearchStore.setState({
    viewId: 'view-1', matchUrnSet: new Set(urns), orderedMatchUrns: urns, orderedEdgeKeys: [], focusedMatchIndex: null,
  } as never)
}

function renderBox(session: ViewSearchSession) {
  return render(
    <ViewSearchSessionContext.Provider value={session}>
      <HeaderSearch />
    </ViewSearchSessionContext.Provider>,
  )
}

const token = () => screen.getByRole('group', { name: 'Search on the canvas' })
const queryToken = () => screen.queryByRole('group', { name: 'Search on the canvas' })
const box = () => screen.getByRole('combobox', { name: 'Search this view' })
/** The token's own face — its button — apart from what it says to a reader. */
const face = () => within(token()).getByRole('button', { name: /^(Highlighting|Showing only|Hiding)/ })
const openCard = () => {
  fireEvent.click(face())
  return screen.getByRole('dialog', { name: 'Search on the canvas' })
}

beforeEach(() => {
  window.localStorage.clear()
  usePersonaStore.setState({ mode: 'technical' })
})
afterEach(() => {
  useSearchStore.setState({
    matchUrnSet: new Set(), orderedMatchUrns: [], orderedEdgeKeys: [], focusedMatchIndex: null, canvasFilterMode: 'highlight',
  } as never)
  vi.restoreAllMocks()
})


describe('HeaderSearch — a search on the canvas, not typed here', () => {
  it('stands a token where the placeholder was, saying what the search is doing', () => {
    lit()
    renderBox(fromThePanel())

    expect(token()).toHaveAttribute('data-search-token', 'advanced')
    expect(token()).toHaveAttribute('data-search-mode', 'highlight')
    expect(within(token()).getByRole('button', { name: 'Highlighting 3 matches' })).toHaveTextContent('Highlighting 3 matches')
    // What is typed beside it starts a new search.
    expect(box()).toHaveAttribute('placeholder', 'New search…')
  })

  it('says nothing while no search is lit', () => {
    renderBox(fromThePanel())
    expect(queryToken()).toBeNull()
    expect(box()).toHaveAttribute('placeholder', 'Search this view…')
  })

  it('takes the mode\'s words and colour', () => {
    lit()
    useSearchStore.setState({ canvasFilterMode: 'isolate' } as never)
    const { unmount } = renderBox(fromThePanel())
    expect(token()).toHaveAttribute('data-search-mode', 'isolate')
    expect(token()).toHaveTextContent('Showing only 3 matches')
    unmount()

    useSearchStore.setState({ canvasFilterMode: 'hide' } as never)
    renderBox(fromThePanel())
    expect(token()).toHaveTextContent('Hiding 3 matches')
  })

  it('counts one as one, and a count the server could not finish as a floor', () => {
    lit(['a'])
    const { unmount } = renderBox(fromThePanel({
      advanced: stubAdvanced({ view: resultsView({ totalCount: 1, candidateCount: 1, truncated: false, hits: [hit('a')] }) }),
    }))
    expect(token()).toHaveTextContent('Highlighting 1 match')
    unmount()

    renderBox(fromThePanel({
      advanced: stubAdvanced({ view: resultsView({ candidateCount: 5000, truncated: true, hits: [hit('a')] }) }),
    }))
    expect(token()).toHaveTextContent('Highlighting 5,000+ matches')
  })

  it('carries its own ×, and the box offers none of its own beside it', () => {
    lit()
    const session = fromThePanel()
    renderBox(session)

    const clears = screen.getAllByRole('button', { name: 'Clear search' })
    expect(clears).toHaveLength(1)
    expect(token()).toContainElement(clears[0])
    fireEvent.click(clears[0])
    expect(session.clearQuery).toHaveBeenCalledOnce()
  })

  it('steps through the matches and shows each on the canvas', () => {
    lit()
    const session = fromThePanel()
    renderBox(session)

    fireEvent.click(within(token()).getByRole('button', { name: 'Next match' }))
    expect(useSearchStore.getState().focusedMatchIndex).toBe(0)
    expect(token()).toHaveTextContent('1/3')
    expect(session.revealHit).toHaveBeenCalledWith('a', [anc('crm')])

    fireEvent.click(within(token()).getByRole('button', { name: 'Previous match' }))
    expect(useSearchStore.getState().focusedMatchIndex).toBe(2)
    expect(session.revealHit).toHaveBeenLastCalledWith('c', [])
  })

  it('leaves routes and connections to the panel', () => {
    lit()
    renderBox(fromThePanel({
      advanced: stubAdvanced({ view: resultsView({ totalCount: 2, candidateCount: 2, truncated: false, hits: [], paths: [] }) }),
    }))
    expect(token()).toHaveTextContent('Highlighting 2 routes')
    expect(within(token()).queryByRole('button', { name: 'Next match' })).toBeNull()
  })

  it('does not step while the panel is open, which steps itself', () => {
    lit()
    renderBox(fromThePanel({ panelOpen: true }))
    expect(token()).toBeInTheDocument()
    expect(within(token()).queryByRole('button', { name: 'Next match' })).toBeNull()
  })

  it('stays while something new is typed beside it, until the box runs that', () => {
    lit()
    renderBox(fromThePanel({ quick: { ...DEFAULT_QUICK, text: 'cu' } }))
    expect(token()).toHaveAttribute('data-search-token', 'advanced')
    expect(box()).toHaveValue('cu')
  })

  it('makes the sparkles that search\'s Edit', () => {
    lit()
    const session = fromThePanel()
    renderBox(session)
    fireEvent.click(screen.getByRole('button', { name: 'Edit this search' }))
    expect(session.refine).toHaveBeenCalledOnce()
  })

  it('leaves the count to the token, and the status line under the box quiet', () => {
    lit()
    renderBox(fromThePanel())
    expect(screen.queryByText(/3 matches · 2 layers/)).toBeNull()
  })
})


describe('HeaderSearch — a search typed in the box', () => {
  it('lets the words say what was searched, and adds the count and the step', () => {
    lit()
    renderBox(typed())

    expect(box()).toHaveValue('orders')
    expect(token()).toHaveAttribute('data-search-token', 'typed')
    expect(face()).toHaveTextContent(/^3$/)
    // Its words are in the button's name, for whoever cannot see the colour.
    expect(face()).toHaveAccessibleName('Highlighting 3 matches')
    expect(within(token()).getByRole('button', { name: 'Next match' })).toBeInTheDocument()
  })

  it('is cleared by the box\'s own ×, which says it takes the highlights too', () => {
    lit()
    const session = typed()
    renderBox(session)

    expect(within(token()).queryByRole('button', { name: 'Clear search' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(session.clearQuery).toHaveBeenCalledOnce()
  })

  it('dims while the box holds words its search has not answered yet', () => {
    lit()
    renderBox(typed({ quick: { ...DEFAULT_QUICK, text: 'ordersx' }, resultMatchesQuick: false }))
    expect(token()).toHaveAttribute('data-search-token', 'typed')
    expect(token().className).toMatch(/opacity-55/)
  })

  it('is the box\'s when its words are the search on the canvas, whoever ran it', () => {
    lit()
    renderBox(typed({ resultFromBox: false, resultMatchesQuick: true }))
    expect(token()).toHaveAttribute('data-search-token', 'typed')
  })
})


describe('HeaderSearch — the search\'s card', () => {
  it('switches the mode, and remembers it for this view', () => {
    lit()
    renderBox(fromThePanel())
    const card = openCard()

    const modes = within(card).getByRole('radiogroup', { name: 'How the matches show on the canvas' })
    expect(within(modes).getByRole('radio', { name: 'Highlight' })).toHaveAttribute('aria-checked', 'true')
    // The card opens on the mode the canvas is in.
    expect(within(modes).getByRole('radio', { name: 'Highlight' })).toHaveFocus()

    fireEvent.click(within(modes).getByRole('radio', { name: 'Show only' }))
    expect(useSearchStore.getState().canvasFilterMode).toBe('isolate')
    expect(readPersistedCanvasFilterMode('view-1')).toBe('isolate')
    expect(token()).toHaveTextContent('Showing only 3 matches')
    expect(card).toHaveTextContent('Rows that don’t match are hidden from the canvas.')
  })

  it('names the layers the matches are in, in board order', () => {
    lit()
    renderBox(fromThePanel())
    const card = openCard()

    expect(card).toHaveTextContent('In 2 layers')
    expect(within(card).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Sources', 'Reports'])
  })

  it('edits the search, or clears it', () => {
    lit()
    const session = fromThePanel()
    renderBox(session)

    fireEvent.click(within(openCard()).getByRole('button', { name: /Edit search/ }))
    expect(session.refine).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog', { name: 'Search on the canvas' })).toBeNull()

    fireEvent.click(within(openCard()).getByRole('button', { name: 'Clear' }))
    expect(session.clearQuery).toHaveBeenCalledOnce()
  })

  it('names the mode as the panel does only in the Technical view', () => {
    lit()
    useSearchStore.setState({ canvasFilterMode: 'isolate' } as never)
    const { unmount } = renderBox(fromThePanel())
    expect(openCard()).toHaveTextContent('Isolate')
    unmount()

    usePersonaStore.setState({ mode: 'business' })
    renderBox(fromThePanel())
    expect(openCard()).not.toHaveTextContent('Isolate')
  })

  it('closes on Esc without clearing the search under it', () => {
    lit()
    const session = fromThePanel()
    renderBox(session)
    const card = openCard()

    fireEvent.keyDown(card, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Search on the canvas' })).toBeNull()
    expect(session.clearQuery).not.toHaveBeenCalled()
    // The card owns its keys: the canvas's Esc never sees one pressed in it.
    expect(card.closest('[data-keyboard-scope]')).not.toBeNull()
  })
})


describe('HeaderSearch — a narrow box', () => {
  // jsdom lays nothing out: give every element the width of a cramped box's
  // middle, where the token and the input share 150px.
  const narrow = () => vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 150, height: 28, top: 0, left: 0, right: 150, bottom: 28, x: 0, y: 0 } as DOMRect)

  it('gives up its words, its step and its × to its card, never the input', () => {
    narrow()
    lit()
    const session = fromThePanel()
    renderBox(session)

    expect(face()).toHaveTextContent(/^3$/)
    expect(within(token()).queryByRole('button', { name: 'Next match' })).toBeNull()
    expect(within(token()).queryByRole('button', { name: 'Clear search' })).toBeNull()

    const card = openCard()
    fireEvent.click(within(card).getByRole('button', { name: 'Next match' }))
    expect(card).toHaveTextContent('1 of 3')
    expect(session.revealHit).toHaveBeenCalledWith('a', [anc('crm')])
    fireEvent.click(within(card).getByRole('button', { name: 'Clear' }))
    expect(session.clearQuery).toHaveBeenCalledOnce()
  })

  it('keeps its step in its card while the box has no room for it, even typed', () => {
    narrow()
    lit()
    renderBox(typed())
    expect(within(token()).queryByRole('button', { name: 'Next match' })).toBeNull()
    expect(openCard()).toHaveTextContent('– of 3')
  })
})
