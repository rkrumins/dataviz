/**
 * LensStatusBar — the Lens's footer as a status bar (2026-08-22).
 *
 * It was one italic sentence of hints and a wide blank. Now: the gestures
 * as keycaps on the left, a legend of what the wires mean in the middle,
 * and live facts about the board on the right.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LensStatusBar } from '../LensStatusBar'

describe('LensStatusBar', () => {
  it('says the gestures as keycaps', () => {
    render(<LensStatusBar cards={23} wires={108} bundles={0} zoom={0.91} />)
    const keys = screen.getAllByRole('term').map(k => k.textContent)
    expect(keys).toEqual(expect.arrayContaining(['Click', '⊕', '▸', '↑↓', '↵', '⇧↵', 'Esc']))
    expect(screen.getByText(/walk a hop/i)).toBeInTheDocument()
    expect(screen.getByText(/open what is inside/i)).toBeInTheDocument()
    expect(screen.getByText(/^close$/i)).toBeInTheDocument()
  })

  it('explains the wires: upstream, downstream, coarse, bundle', () => {
    render(<LensStatusBar cards={1} wires={0} bundles={0} zoom={null} />)
    const legend = screen.getByRole('list', { name: /what the wires mean/i })
    expect(legend).toHaveTextContent('upstream')
    expect(legend).toHaveTextContent('downstream')
    expect(legend).toHaveTextContent('≈ coarse')
    expect(legend).toHaveTextContent('bundle')
  })

  it('states what is on the board, and the zoom once it is known', () => {
    const { rerender } = render(<LensStatusBar cards={23} wires={108} bundles={2} zoom={0.9136} />)
    expect(screen.getByRole('note', { name: /on the board/i })).toHaveTextContent('23 cards · 108 wires · 2 bundles · 91%')
    rerender(<LensStatusBar cards={1} wires={1} bundles={0} zoom={null} />)
    expect(screen.getByRole('note', { name: /on the board/i })).toHaveTextContent('1 card · 1 wire')
    expect(screen.getByRole('note', { name: /on the board/i })).not.toHaveTextContent('%')
  })
})
