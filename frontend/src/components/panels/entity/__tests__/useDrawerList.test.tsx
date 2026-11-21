/**
 * useDrawerList — a long list in the drawer draws only the rows on screen, and rows measured as they
 * come into view are drawn together: one draw, however many were measured. Drawn once per row, a
 * scroll through the bulk dialog's ~300 merge groups drew the list a dozen times a step, in one task.
 */
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DrawerScrollContext } from '@/components/panels/shell/drawerScroll'
import { useDrawerList } from '../multi/useDrawerList'

/** A ResizeObserver the test reports sizes through, as the browser does: one callback, many rows. */
const observers: Array<{ report: ResizeObserverCallback; targets: Set<Element> }> = []
class ReportingResizeObserver {
  private o: { report: ResizeObserverCallback; targets: Set<Element> }
  constructor(report: ResizeObserverCallback) {
    this.o = { report, targets: new Set() }
    observers.push(this.o)
  }
  observe(el: Element) { this.o.targets.add(el) }
  unobserve(el: Element) { this.o.targets.delete(el) }
  disconnect() { this.o.targets.clear() }
}

const realObserver = globalThis.ResizeObserver
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
beforeEach(() => {
  observers.length = 0
  globalThis.ResizeObserver = ReportingResizeObserver as unknown as typeof ResizeObserver
  // jsdom lays nothing out: the drawer's body is 300px tall, and so is each row as first drawn.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
})
afterEach(() => {
  globalThis.ResizeObserver = realObserver
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
})

let draws = 0
function Rows({ count }: { count: number }) {
  const { listRef, virtualizer } = useDrawerList(count, 50, (i) => `row${i}`)
  draws++
  return (
    <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((item) => <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} />)}
    </div>
  )
}
function Drawer({ onBody }: { onBody: (el: HTMLElement) => void }) {
  const [body, setBody] = useState<HTMLElement | null>(null)
  return (
    <div ref={(el) => { if (el) { setBody(el); onBody(el) } }}>
      <DrawerScrollContext.Provider value={body}>{body && <Rows count={1000} />}</DrawerScrollContext.Provider>
    </div>
  )
}

it('draws the rows measured as they come into view once, together', async () => {
  let body: HTMLElement | null = null
  render(<Drawer onBody={(el) => { body = el }} />)
  // Scrolled far down: the rows now in view are new, drawn while it scrolls, not measured yet.
  Object.defineProperty(body!, 'scrollTop', { configurable: true, writable: true, value: 30_000 })
  await act(async () => { body!.dispatchEvent(new Event('scroll')) })
  const rows = observers.find((o) => [...o.targets].some((t) => t.hasAttribute('data-index')))!
  const unmeasured = [...rows.targets].filter((t) => t.isConnected && Number(t.getAttribute('data-index')) > 100)
  expect(unmeasured.length).toBeGreaterThan(8)

  // The browser reports them in one callback, each taller than estimated — those above the fold
  // move the scroll position to keep what is read in place.
  draws = 0
  await act(async () => {
    rows.report(unmeasured.map((target) => ({ target, borderBoxSize: [{ blockSize: 80, inlineSize: 300 }] }) as unknown as ResizeObserverEntry),
      rows as unknown as ResizeObserver)
  })
  expect(draws).toBeGreaterThan(0)
  expect(draws).toBeLessThanOrEqual(2)
})
