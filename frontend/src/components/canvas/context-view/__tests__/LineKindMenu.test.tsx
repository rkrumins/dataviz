/**
 * The Lineage button's menu: relationships only, or roll-ups too — opens on the current choice,
 * a pick sets it and closes, Esc hands focus back to the button.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePreferencesStore } from '@/store/preferences'
import { LineKindMenu } from '../header/LineKindMenu'

beforeEach(() => usePreferencesStore.setState({ showLineageRollups: false }))

function setup() {
  const onClose = vi.fn()
  const triggerRef = createRef<HTMLButtonElement>()
  render(<><button ref={triggerRef}>Lines</button><LineKindMenu onClose={onClose} triggerRef={triggerRef} /></>)
  return { onClose, trigger: () => triggerRef.current! }
}

describe('LineKindMenu', () => {
  it('opens on the current choice — relationships only, by default', () => {
    setup()
    const current = screen.getByRole('menuitemradio', { name: /Relationships only/ })
    expect(current).toHaveAttribute('aria-checked', 'true')
    expect(current).toHaveFocus()
    expect(screen.getByRole('menuitemradio', { name: /Include roll-ups/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('a pick sets the choice and closes', async () => {
    const user = userEvent.setup()
    const { onClose } = setup()
    await user.click(screen.getByRole('menuitemradio', { name: /Include roll-ups/ }))
    expect(usePreferencesStore.getState().showLineageRollups).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('Esc closes it and hands focus back to the button', () => {
    const { onClose, trigger } = setup()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(trigger()).toHaveFocus()
  })
})
