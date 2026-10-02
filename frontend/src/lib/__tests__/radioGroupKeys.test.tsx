/**
 * A radio group answers the arrow keys: the choice moves to the next enabled option (skipping a
 * disabled one, wrapping round) and focus follows it.
 */
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { onRadioGroupKeyDown } from '../radioGroupKeys'

function Group() {
  const [value, setValue] = useState('a')
  return (
    <div role="radiogroup" aria-label="Pick" onKeyDown={onRadioGroupKeyDown}>
      {['a', 'b', 'c'].map(v => (
        <button key={v} type="button" role="radio" aria-checked={value === v} tabIndex={value === v ? 0 : -1}
          disabled={v === 'b'} onClick={() => setValue(v)}>{v}</button>
      ))}
    </div>
  )
}

describe('onRadioGroupKeyDown', () => {
  it('moves the choice past a disabled option, wraps round, and focus follows', () => {
    render(<Group />)
    const a = screen.getByRole('radio', { name: 'a' })
    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowRight' })
    const c = screen.getByRole('radio', { name: 'c' })
    expect(c).toHaveAttribute('aria-checked', 'true')
    expect(c).toHaveFocus()
    expect(c).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(c, { key: 'ArrowDown' })
    expect(a).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(a, { key: 'ArrowLeft' })
    expect(c).toHaveAttribute('aria-checked', 'true')
  })
})
