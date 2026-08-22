/**
 * ViewControl — a category chip that opens its options (2026-08-22).
 *
 * "Break this down into different categories that the user clicks and
 * can control." A chip names the category and its CURRENT value; the
 * click opens a menu where every option carries its name and one line
 * of meaning — no hover needed to understand a choice before making it.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Layers, Group, LayoutGrid } from 'lucide-react'
import { ViewControl } from '../ViewControl'

const OPTIONS = [
  { value: 'overview', label: 'Overview', Icon: Layers, meaning: 'Start at the high level' },
  { value: 'grouped', label: 'Grouped', Icon: Group, meaning: 'Containers open to their strongest rows' },
  { value: 'all', label: 'Every card', Icon: LayoutGrid, meaning: 'Nothing folded' },
] as const

function renderControl(onChange = vi.fn(), value: 'overview' | 'grouped' | 'all' = 'grouped') {
  render(
    <ViewControl caption="Density" meaning="How much of the picture is folded" value={value} options={OPTIONS} onChange={onChange} />,
  )
  return onChange
}

describe('ViewControl', () => {
  it('the chip names the category and its current value, and is a menu button', () => {
    renderControl()
    const chip = screen.getByRole('button', { name: 'Density: Grouped' })
    expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(chip).toHaveTextContent('Density')
    expect(chip).toHaveTextContent('Grouped')
  })

  it('opens to every option with its meaning, the current one checked', () => {
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Density: Grouped' }))
    expect(screen.getByRole('button', { name: 'Density: Grouped' })).toHaveAttribute('aria-expanded', 'true')
    const items = screen.getAllByRole('menuitemradio')
    expect(items.map(i => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByRole('menuitemradio', { name: /Overview/ })).toHaveTextContent('Start at the high level')
    expect(screen.getByRole('menuitemradio', { name: /Every card/ })).toHaveTextContent('Nothing folded')
    // The category's own meaning heads the menu.
    expect(screen.getByRole('menu', { name: 'Density' })).toHaveTextContent('How much of the picture is folded')
  })

  it('choosing an option reports it and closes the menu', () => {
    const onChange = renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Density: Grouped' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Every card/ }))
    expect(onChange).toHaveBeenCalledWith('all')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('the arrow keys walk the options', () => {
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: 'Density: Grouped' }))
    const items = screen.getAllByRole('menuitemradio')
    items[1].focus()
    fireEvent.keyDown(items[1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[2])
    fireEvent.keyDown(items[2], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])          // wraps
    fireEvent.keyDown(items[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[2])
  })
})
