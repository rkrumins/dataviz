/**
 * The tab's memory, as the app can see and act on it.
 *
 * What a reader browsing a graph of millions sees as "the tab froze" is
 * usually memory: a session that keeps every page it ever fetched, or
 * re-derives a board over everything walked so far on every page that
 * lands (measured 2026-09-21: a Focus Lens walk allocating ~7 GB every
 * twenty seconds; a response cache that never dropped an entry). The fixes
 * bound those; this is how the reader — and we — can SEE the footprint, and
 * give back what can be refetched.
 *
 * `readHeap` is the script heap Chrome reports (`performance.memory`,
 * Chromium only — elsewhere nothing is shown rather than a guess). It is
 * not the whole tab — the DOM, layout and graphics live outside it — but it
 * is the part this app allocates and can release.
 */
import { releaseProviderCaches } from '@/providers/providerPool'
import { RELEASE_MEMORY_EVENT } from './memoryEvents'

export { RELEASE_MEMORY_EVENT }

/** The gauge shows itself from here on, amber. */
export const HEAP_HIGH_BYTES = 1024 ** 3
/** …and turns red from here. */
export const HEAP_VERY_HIGH_BYTES = 2 * 1024 ** 3

export interface HeapReading {
  /** Script heap in use, bytes. */
  used: number
  /** The most the browser will give this tab's script heap, bytes. */
  limit: number
}

export function readHeap(): HeapReading | null {
  const m = (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } } | undefined)?.memory
  if (!m || !(m.usedJSHeapSize > 0)) return null
  return { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit }
}

export type HeapLevel = 'ok' | 'high' | 'very-high'

export function heapLevel(used: number): HeapLevel {
  return used >= HEAP_VERY_HIGH_BYTES ? 'very-high' : used >= HEAP_HIGH_BYTES ? 'high' : 'ok'
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/** Give back everything that can be refetched: every pooled provider's
 *  cached responses, and — through `RELEASE_MEMORY_EVENT` — the walks the
 *  Lens and the drawer are not showing. Returns the responses dropped. */
export function releaseMemory(): number {
  window.dispatchEvent(new Event(RELEASE_MEMORY_EVENT))
  return releaseProviderCaches()
}
