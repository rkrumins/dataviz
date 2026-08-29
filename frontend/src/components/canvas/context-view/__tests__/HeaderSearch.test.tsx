/**
 * HeaderSearch — the header box against a stubbed session.
 *
 * The box owns no search state of its own any more: every gesture is a
 * call on the one session the canvas provides, so each spec asserts on
 * the CALL rather than on what re-rendered. The two that don't — the
 * scope chip and the status line — read the session's own state back.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_QUICK } from '@/components/canvas/search/session/quickPredicate'
import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import type { PanelView } from '@/hooks/useAdvancedSearch'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { HeaderSearch } from '../header/HeaderSearch'

const BOX = /search this view/i

function renderBox(session: ViewSearchSession) {
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <HeaderSearch />
    </ViewSearchSessionContext.Provider>,
  )
}

/** A finished run. Only `result` is read by the status line; the
 *  template/inputs/query half of the view belongs to the panel. */
function resultsView(result: Record<string, unknown>): PanelView {
  return {
    kind: 'results', template: {}, inputs: {}, query: {},
    result, elapsedMs: 12,
  } as unknown as PanelView
}

describe('HeaderSearch', () => {
  it('sends what was typed to the session', () => {
    const session = stubSession()
    renderBox(session)

    fireEvent.change(screen.getByPlaceholderText(BOX), { target: { value: 'orders' } })

    expect(session.setQuick).toHaveBeenCalledWith({ text: 'orders' })
  })

  it('runs on Enter', () => {
    const session = stubSession({ quick: { ...DEFAULT_QUICK, text: 'orders' } })
    renderBox(session)

    fireEvent.keyDown(screen.getByPlaceholderText(BOX), { key: 'Enter' })

    expect(session.runNow).toHaveBeenCalledTimes(1)
  })

  it('clears the whole query on Escape', () => {
    const session = stubSession({ quick: { ...DEFAULT_QUICK, text: 'orders' } })
    renderBox(session)

    fireEvent.keyDown(screen.getByPlaceholderText(BOX), { key: 'Escape' })

    expect(session.clearQuery).toHaveBeenCalledTimes(1)
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
})
