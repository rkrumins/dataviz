import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom implements neither of these, and cmdk (the command/omnibox
// primitive) uses both on mount — a ResizeObserver to track its list
// and scrollIntoView to keep the active item visible. Without the
// stubs every test that renders a cmdk surface dies in a passive
// effect with a bare ReferenceError.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

afterEach(() => {
  cleanup()
})
