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

// jsdom has no EventSource, and the change feed opens one as soon as it
// starts. Without this, any test that mounts the app tree — or anything
// that transitively starts the feed — dies with a bare ReferenceError
// far from the code that caused it.
//
// Inert on purpose: it connects to nothing and emits nothing, so tests
// that do not care about streaming are unaffected, and tests that DO
// care construct their own double rather than trying to drive this one.
if (typeof globalThis.EventSource === 'undefined') {
  class InertEventSource {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSED = 2
    readyState = 0
    url: string
    withCredentials: boolean
    onopen: ((ev: Event) => void) | null = null
    onmessage: ((ev: MessageEvent) => void) | null = null
    onerror: ((ev: Event) => void) | null = null

    constructor(url: string | URL, init?: { withCredentials?: boolean }) {
      this.url = String(url)
      this.withCredentials = Boolean(init?.withCredentials)
    }

    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return false
    }
    close() {
      this.readyState = 2
    }
  }
  globalThis.EventSource = InertEventSource as unknown as typeof EventSource
}

afterEach(() => {
  cleanup()
})
