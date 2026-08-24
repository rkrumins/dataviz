import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { cancelHealthProbes } from '@/store/health'

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
  // The health store defers its probes (250ms, then 2s). Without this a
  // file that provokes one request failure leaves a live timer that
  // fires inside the NEXT file, or after teardown — where
  // `navigator.onLine` throws a ReferenceError that vitest reports as an
  // unhandled error against a test that had nothing to do with it.
  cancelHealthProbes()
})
