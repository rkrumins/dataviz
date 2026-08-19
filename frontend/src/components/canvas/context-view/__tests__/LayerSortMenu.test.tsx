/**
 * LayerSortMenu — the per-column sort dropdown.
 *
 * THE INVARIANT UNDER TEST: canvas dropdowns must be NON-MODAL
 * (`modal={false}`). A modal Radix DropdownMenu sets
 * `document.body.style.pointerEvents = 'none'` while open; if its host
 * column unmounts or re-keys while the menu is open, the cleanup that
 * restores the body is skipped and the whole app goes pointer-dead until
 * the watchdog happens to be woken (see radixPointerEventsGuard and the
 * b7bb5535 sweep). Reported live 2026-08-19 as "Entity Drawer trace
 * buttons need 3-4 clicks".
 */
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { LayerSortMenu } from '../LayerSortMenu'

afterEach(() => {
  cleanup()
  document.body.style.pointerEvents = ''
})

function renderMenu() {
  return render(
    <LayerSortMenu
      layerName="Warehouse"
      layerColor="#6366f1"
      mode="alpha-asc"
      isOverride={false}
      viewDefault="alpha-asc"
      canPersist={false}
      onSelectMode={vi.fn()}
      onApplyToView={vi.fn()}
      onResetCustomOrder={vi.fn()}
    />,
  )
}

describe('LayerSortMenu — non-modal invariant', () => {
  it('opening the menu never locks the body (modal would strand the app pointer-dead on abnormal unmount)', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: /sort warehouse/i }))
    // The menu is open…
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    // …and the body is still interactive.
    expect(document.body.style.pointerEvents).not.toBe('none')
  })

  it('unmounting while open leaves the body interactive', async () => {
    const user = userEvent.setup()
    const { unmount } = renderMenu()
    await user.click(screen.getByRole('button', { name: /sort warehouse/i }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    unmount()
    expect(document.body.style.pointerEvents).not.toBe('none')
  })
})
