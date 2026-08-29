/**
 * HeaderSearch — the header box and the list under it, against a stubbed
 * session.
 *
 * The box owns no search state of its own: every gesture is a call on the
 * one session the canvas provides, so most specs assert on the CALL
 * rather than on what re-rendered. What the box DOES own is the list —
 * whether it is open, which row is active, and what each key does — and
 * those specs assert on the surface, because there is nowhere else for
 * that state to live.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_QUICK } from '@/components/canvas/search/session/quickPredicate'
import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'
import type { AncestorRef, SearchHit } from '@/types/search'

import { HeaderSearch } from '../header/HeaderSearch'

const BOX = /search this view/i
const RECENTS_KEY = 'nexus.viewSearch.recent.view-1'

function renderBox(session: ViewSearchSession) {
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <HeaderSearch />
    </ViewSearchSessionContext.Provider>,
  )
}

/** A finished run. Only `result` is read by the status line and the
 *  list; the template/inputs/query half of the view belongs to the panel. */
function resultsView(result: Record<string, unknown>): PanelView {
  return {
    kind: 'results', template: {}, inputs: {}, query: {},
    result, elapsedMs: 12,
  } as unknown as PanelView
}

function anc(displayName: string): AncestorRef {
  return { urn: `urn:${displayName}`, displayName, entityType: 'container' }
}

function hit(displayName: string, ancestorPath: AncestorRef[] = []): SearchHit {
  return {
    node: {
      urn: `urn:${displayName}`, displayName, entityType: 'dataset', properties: {},
    },
    ancestorPath,
    highlights: [],
  } as unknown as SearchHit
}

/** A session standing on an answer to what is in the box. */
function answering(hits: SearchHit[], over: Record<string, unknown> = {}) {
  return stubSession({
    quick: { ...DEFAULT_QUICK, text: 'orders' },
    resultMatchesQuick: true,
    advanced: stubAdvanced({
      view: resultsView({
        candidateCount: hits.length, truncated: false, hits, ...over,
      }),
      runState: { hash: 'h1' } as never,
    }),
  })
}

function box() {
  return screen.getByPlaceholderText(BOX)
}

function openList() {
  fireEvent.focus(box())
}

beforeEach(() => { window.localStorage.clear() })
afterEach(() => { vi.useRealTimers() })


describe('HeaderSearch — the box', () => {
  it('sends what was typed to the session', () => {
    const session = stubSession()
    renderBox(session)

    fireEvent.change(box(), { target: { value: 'orders' } })

    expect(session.setQuick).toHaveBeenCalledWith({ text: 'orders' })
  })

  it('shows the container a scoped search is clamped to, and unclamps it', () => {
    const session = stubSession({
      quick: { ...DEFAULT_QUICK, scope: { insideUrn: 't1', label: 'orders' } },
    })
    renderBox(session)

    expect(screen.getByText('inside orders')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /search the whole view/i }))
    expect(session.clearScope).toHaveBeenCalledTimes(1)
  })

  it('picks a match mode by its builder label', () => {
    const session = stubSession()
    renderBox(session)

    fireEvent.click(screen.getByRole('button', { name: 'Match: Contains' }))
    fireEvent.click(screen.getByRole('button', { name: 'Starts with' }))

    expect(session.setQuick).toHaveBeenCalledWith({ match: 'prefix' })
  })

  // The list is portalled to document.body, so without these a keyboard
  // user reaches it only by tabbing past the entire app — and lands
  // nowhere at all once it closes.
  it('moves focus into the menu when it opens', () => {
    renderBox(stubSession())

    fireEvent.click(screen.getByRole('button', { name: 'Match: Contains' }))

    expect(screen.getByRole('button', { name: 'Contains' })).toHaveFocus()
  })

  it('returns focus to the trigger when an item is chosen', () => {
    renderBox(stubSession())
    const trigger = screen.getByRole('button', { name: 'Match: Contains' })

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Starts with' }))

    expect(trigger).toHaveFocus()
  })

  it('shows the wider box placeholder', () => {
    renderBox(stubSession())

    expect(screen.getByPlaceholderText('Search this view…')).toBeInTheDocument()
  })

  it('renders Look in and Match as icon triggers labelled with their current value', () => {
    renderBox(stubSession())

    expect(screen.getByRole('button', { name: 'Look in: Everything' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Match: Contains' })).toBeInTheDocument()
  })

  it('flags a narrowed Match with a dot, and leaves the default Look in bare', () => {
    const session = stubSession({ quick: { ...DEFAULT_QUICK, match: 'prefix' } })
    renderBox(session)

    const matchTrigger = screen.getByRole('button', { name: 'Match: Starts with' })
    expect(matchTrigger.querySelector('[data-testid="narrowed-dot"]')).not.toBeNull()

    const lookInTrigger = screen.getByRole('button', { name: 'Look in: Everything' })
    expect(lookInTrigger.querySelector('[data-testid="narrowed-dot"]')).toBeNull()
  })

  it('states the current value in the popover header', () => {
    renderBox(stubSession())

    fireEvent.click(screen.getByRole('button', { name: 'Match: Contains' }))

    expect(screen.getByText('Match · Contains')).toBeInTheDocument()
  })

  it('opens the builder from Refine', () => {
    const session = stubSession()
    renderBox(session)

    fireEvent.click(screen.getByRole('button', { name: /refine/i }))

    expect(session.refine).toHaveBeenCalledTimes(1)
  })
})


describe('HeaderSearch — the status line', () => {
  it('reports the whole candidate count, not the page it rendered', () => {
    const session = stubSession({
      advanced: stubAdvanced({
        view: resultsView({ candidateCount: 1284, truncated: false, hits: [] }),
      }),
    })
    renderBox(session)

    expect(screen.getByText(/1,284 matches/)).toBeInTheDocument()
  })

  it('counts one match in one layer without an English mistake', () => {
    const session = stubSession({
      resolveLayer: vi.fn(() => 'gold'),
      advanced: stubAdvanced({
        view: resultsView({
          candidateCount: 1, truncated: false, hits: [{ node: { urn: 'a' } }],
        }),
      }),
    })
    renderBox(session)

    expect(screen.getByText('1 match · 1 layer')).toBeInTheDocument()
  })

  // "More than this" is what the plus means. With an exact total on the
  // wire there is no more than it — the run was capped, the COUNT was not.
  it('drops the plus when the server sent an exact total', () => {
    const session = stubSession({
      advanced: stubAdvanced({
        view: resultsView({ totalCount: 1284, candidateCount: 50000, truncated: true, hits: [] }),
      }),
    })
    renderBox(session)

    expect(screen.getByText(/1,284 matches/)).toBeInTheDocument()
    expect(screen.queryByText(/1,284\+/)).not.toBeInTheDocument()
  })

  it('keeps the plus when a truncated run could not be counted', () => {
    const session = stubSession({
      advanced: stubAdvanced({
        view: resultsView({ candidateCount: 50000, truncated: true, hits: [] }),
      }),
    })
    renderBox(session)

    expect(screen.getByText(/50,000\+ matches/)).toBeInTheDocument()
  })
})


describe('HeaderSearch — opening and closing the list', () => {
  it('opens on focus with what was searched in this view before', () => {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(['orders', 'customer id']))
    renderBox(stubSession())

    openList()

    expect(screen.getByText('Recent in this view')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'orders' })).toBeInTheDocument()
  })

  it('a recent puts its text back in the box and runs it', () => {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(['orders']))
    const session = stubSession()
    renderBox(session)
    openList()

    fireEvent.click(screen.getByRole('button', { name: 'orders' }))

    expect(session.setQuick).toHaveBeenCalledWith({ text: 'orders' })
    expect(session.runNow).toHaveBeenCalledTimes(1)
  })

  it('a keystroke re-opens a list Escape put away', () => {
    renderBox(stubSession())
    openList()
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByText('Recent in this view')).not.toBeInTheDocument()

    fireEvent.change(box(), { target: { value: 'o' } })

    expect(screen.getByText(/searches names, descriptions, tags/i)).toBeInTheDocument()
  })

  it('closes on a click outside it', () => {
    renderBox(answering([hit('orders')]))
    openList()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes when Tab takes the user on', () => {
    renderBox(answering([hit('orders')]))
    openList()

    fireEvent.keyDown(box(), { key: 'Tab' })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  // The Look-in and Match popovers are portalled `role="dialog"` surfaces
  // OUTSIDE the box's DOM. Reading a click in one as "clicked away" put
  // the list away the moment the user went to narrow the search.
  it('stays open while one of the box\'s own popovers is used', () => {
    renderBox(answering([hit('orders')]))
    openList()

    // The Match menu, not Look in: opening Look in fetches the view's
    // property keys, and this spec is about the click, not the fetch.
    const trigger = screen.getByRole('button', { name: 'Match: Contains' })
    fireEvent.mouseDown(trigger)
    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Starts with' }))

    expect(screen.getByRole('listbox')).toBeInTheDocument()
  })

  it('stays shut while a two-character query has nothing to report yet', () => {
    renderBox(stubSession({ quick: { ...DEFAULT_QUICK, text: 'or' } }))

    openList()

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/searches names, descriptions, tags/i)).not.toBeInTheDocument()
  })
})


describe('HeaderSearch — the keyboard', () => {
  it('walks the rows with the arrows, and says which one it is on', () => {
    renderBox(answering([hit('a'), hit('b'), hit('c')]))
    openList()

    const options = () => screen.getAllByRole('option')
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0].id)

    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[1].id)
    expect(options()[1].getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(box(), { key: 'End' })
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[2].id)

    // Wrapping: the list is ten rows at most, and a user holding ↓ should
    // come back round rather than stick.
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0].id)

    fireEvent.keyDown(box(), { key: 'ArrowUp' })
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[2].id)
  })

  it('Enter reveals the highlighted match on the canvas', () => {
    const session = answering([hit('orders'), hit('orders_daily', [anc('crm')])])
    renderBox(session)
    openList()

    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'Enter' })

    expect(session.revealHit).toHaveBeenCalledWith('urn:orders_daily', [anc('crm')])
    expect(session.runNow).not.toHaveBeenCalled()
  })

  it('Enter asks again when the last run failed — the only way back', () => {
    const session = stubSession({
      quick: { ...DEFAULT_QUICK, text: 'orders' },
      advanced: stubAdvanced({
        view: {
          kind: 'error', template: {}, inputs: {}, query: {},
          message: 'Query deadline exceeded', elapsedMs: 9,
        } as unknown as PanelView,
      }),
    })
    renderBox(session)
    openList()

    expect(screen.getByText('Query deadline exceeded')).toBeInTheDocument()

    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(session.runNow).toHaveBeenCalledTimes(1)
    expect(session.revealHit).not.toHaveBeenCalled()
  })

  it('⌘Enter escalates to the whole result set', () => {
    const session = answering([hit('orders')])
    renderBox(session)
    openList()

    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })

    expect(session.openPanel).toHaveBeenCalledTimes(1)
    expect(session.revealHit).not.toHaveBeenCalled()
  })

  it('Escape puts the list away first and clears the query second', () => {
    const session = answering([hit('orders')])
    renderBox(session)
    openList()

    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(session.clearQuery).not.toHaveBeenCalled()

    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(session.clearQuery).toHaveBeenCalledTimes(1)
  })
})


describe('HeaderSearch — picking', () => {
  it('reveals the hit, closes the list and keeps the query', () => {
    const session = answering([hit('orders_daily', [anc('crm'), anc('public')])])
    renderBox(session)
    openList()

    fireEvent.click(screen.getAllByRole('option')[0])

    expect(session.revealHit).toHaveBeenCalledWith(
      'urn:orders_daily', [anc('crm'), anc('public')],
    )
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(session.clearQuery).not.toHaveBeenCalled()
    expect(session.setQuick).not.toHaveBeenCalled()
  })

  it('remembers what was picked, for the next empty box', () => {
    renderBox(answering([hit('orders_daily')]))
    openList()

    fireEvent.click(screen.getAllByRole('option')[0])

    expect(JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? '[]'))
      .toEqual(['orders'])
  })

  it('remembers a search that found something, without a pick', () => {
    renderBox(answering([hit('orders_daily')]))

    expect(JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? '[]'))
      .toEqual(['orders'])
  })

  it('does not remember a search that found nothing', () => {
    renderBox(answering([], { candidateCount: 0 }))

    expect(window.localStorage.getItem(RECENTS_KEY)).toBeNull()
  })

  it('a crumb reveals that ancestor, not the hit', () => {
    const session = answering([
      hit('customer_id', [anc('crm'), anc('public'), anc('customers')]),
    ])
    renderBox(session)
    openList()

    fireEvent.click(screen.getByRole('button', { name: 'public' }))

    expect(session.revealHit).toHaveBeenCalledWith('urn:public', [anc('crm')])
  })
})


describe('HeaderSearch — prefetch', () => {
  it('warms the spine of the row the user has settled on', () => {
    vi.useFakeTimers()
    const session = answering([hit('orders', [anc('crm')]), hit('orders_daily')])
    renderBox(session)
    openList()

    vi.advanceTimersByTime(149)
    expect(session.prefetchHit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(session.prefetchHit).toHaveBeenCalledWith('urn:orders', [anc('crm')])
  })

  it('does not warm a row the arrows only passed through', () => {
    vi.useFakeTimers()
    const session = answering([hit('orders', [anc('crm')]), hit('orders_daily')])
    renderBox(session)
    openList()

    vi.advanceTimersByTime(100)
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    vi.advanceTimersByTime(100)
    expect(session.prefetchHit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(50)
    expect(session.prefetchHit).toHaveBeenCalledTimes(1)
    expect(session.prefetchHit).toHaveBeenCalledWith('urn:orders_daily', [])
  })
})
