/**
 * LineageGuide — what Adaptive is drawing, and the way to the rest. Its copy
 * must not promise more than a selection draws (the per-entity cap holds),
 * and "Show all lines" must say that it switches Edge Density.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LineageGuide } from '../LineageGuide'

function openGuide() {
  render(<LineageGuide shown={500} total={2000} hubs={[]} onFocusHub={vi.fn()} onShowAll={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /500 of 2,000/ }))
  return screen.getByRole('dialog', { name: 'Lineage guide' })
}

describe('LineageGuide', () => {
  it('says a selection draws its strongest lines, not all of them', () => {
    const guide = openGuide()
    expect(guide).toHaveTextContent('Select any entity to draw its incoming and outgoing lines, strongest first.')
    expect(guide).not.toHaveTextContent(/all of its/)
  })

  it('"Show all lines" says it switches Edge Density', () => {
    openGuide()
    expect(screen.getByRole('button', { name: 'Show all lines' })).toHaveAttribute(
      'title', 'Switches Edge Density to All Edges — switch back under Display',
    )
  })
})
