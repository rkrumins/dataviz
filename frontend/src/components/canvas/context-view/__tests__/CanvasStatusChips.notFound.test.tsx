/**
 * The canvas says when placements point at nothing: entities placed in the view that this graph
 * doesn't hold, typically in a view brought in from another environment. They're kept, and the
 * chip lists them (named, with their layer) and says what to do about them.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasStatusChips } from '../CanvasStatusChips'

function renderChips(notFoundPlacements = [
  { urn: 'urn:li:dataset:(hive,finance.orders,PROD)', label: 'orders', layerName: 'Sources' },
  { urn: 'urn:li:dataset:(hive,finance.ledger,PROD)', label: 'ledger', layerName: 'Marts' },
]) {
  return render(
    <CanvasStatusChips unresolvedEdgeCount={0} unassignedEntities={[]} aggDetailShown={0} aggDetailTotal={0}
      notFoundPlacements={notFoundPlacements} />,
  )
}

describe('CanvasStatusChips — placements not found here', () => {
  it('counts them, and lists them with their layers', () => {
    renderChips()
    fireEvent.click(screen.getByRole('button', { name: /2 placements not found here/ }))
    expect(screen.getByText('Placed in this view, but not in this graph')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
    expect(screen.getByText('Marts')).toBeInTheDocument()
    expect(screen.getByText(/They’re kept, and appear as soon as the entity arrives here/)).toBeInTheDocument()
  })

  it('says nothing when every placement is here', () => {
    const { container } = renderChips([])
    expect(container).toBeEmptyDOMElement()
  })
})
