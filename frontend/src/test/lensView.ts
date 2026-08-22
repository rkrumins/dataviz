/**
 * Choose an option of a Lens view control (2026-08-22). The header's
 * categories — Direction, Density, Wires, Walk, Steps, Next — are chips
 * that open a menu; a test that wants "Root cause" opens the Direction
 * chip and picks it, exactly as a reader does.
 */
import { fireEvent, screen } from '@testing-library/react'

export function chooseView(category: 'Direction' | 'Density' | 'Wires' | 'Walk' | 'Steps' | 'Next', option: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${category}: `) }))
  fireEvent.click(screen.getByRole('menuitemradio', { name: option }))
}

/** The chip's current value, as its label reads it ("Density: Grouped" → "Grouped"). */
export function viewValue(category: 'Direction' | 'Density' | 'Wires' | 'Walk' | 'Steps' | 'Next'): string {
  const chip = screen.getByRole('button', { name: new RegExp(`^${category}: `) })
  return (chip.getAttribute('aria-label') ?? '').replace(`${category}: `, '')
}
