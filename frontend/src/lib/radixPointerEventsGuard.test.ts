import { describe, it, expect, beforeEach } from 'vitest'
import { healStaleBodyLock } from './radixPointerEventsGuard'

/**
 * Reproduces the app-wide click freeze: a modal Radix layer that unmounted
 * while open leaves `document.body` at `pointer-events: none`, so every click
 * in the app is dead until a full reload. The guard clears the stale lock but
 * must never touch it while a real Radix layer is open.
 */
describe('radixPointerEventsGuard', () => {
  beforeEach(() => {
    document.body.style.pointerEvents = ''
    document.body.innerHTML = ''
  })

  it('clears a stale body lock when no Radix layer is open (the freeze)', () => {
    document.body.style.pointerEvents = 'none' // modal unmounted while open
    expect(healStaleBodyLock()).toBe(true)
    expect(document.body.style.pointerEvents).not.toBe('none')
  })

  it('leaves the lock alone while a Radix popper layer is open', () => {
    document.body.style.pointerEvents = 'none'
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-radix-popper-content-wrapper', '')
    document.body.appendChild(wrapper)
    expect(healStaleBodyLock()).toBe(false)
    expect(document.body.style.pointerEvents).toBe('none')
  })

  it('leaves the lock alone while a Radix dialog is open', () => {
    document.body.style.pointerEvents = 'none'
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('data-state', 'open')
    document.body.appendChild(dialog)
    expect(healStaleBodyLock()).toBe(false)
  })

  it('does nothing when the body is not locked', () => {
    expect(healStaleBodyLock()).toBe(false)
    expect(document.body.style.pointerEvents).toBe('')
  })
})
