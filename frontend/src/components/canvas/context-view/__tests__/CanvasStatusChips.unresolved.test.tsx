/**
 * The unresolved chip counts the flows from a drawn row whose other end is
 * outside the view (useEdgeProjection), so in any view it says exactly that:
 * never that something is not loaded, or not on the canvas.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasStatusChips } from '../CanvasStatusChips'

describe('CanvasStatusChips — flows that lead outside the view', () => {
  it.each(['curated', 'all'] as const)('in a %s view, says they lead outside it, and nothing about loading', async (viewScope) => {
    render(
      <CanvasStatusChips unresolvedEdgeCount={3} unassignedEntities={[]} aggDetailShown={0} aggDetailTotal={0}
        viewScope={viewScope} />,
    )
    const label = screen.getByText('flows outside this view')
    fireEvent.focus(label.parentElement!)

    expect((await screen.findAllByText('3 flows lead outside this view')).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/not on canvas|not shown|loaded|Load or assign/i)
  })
})
