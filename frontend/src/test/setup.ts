import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom implements neither of these, and two separate surfaces need them
// on mount: React Flow (Lens graph mode) needs a ResizeObserver to mount
// at all, and cmdk (the command/omnibox primitive) uses a ResizeObserver
// to track its list plus scrollIntoView to keep the active item visible.
// Without the stubs those tests die in a passive effect with a bare
// ReferenceError. Both guarded so a future jsdom that ships them wins.
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
