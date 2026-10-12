/**
 * A selection wider than a trace takes is TOLD so. The walk follows the first
 * `MAX_TRACE_SEEDS` of it, and the rest must not silently fall off the
 * picture. The cap is lowered to 2 here, so three entities cross it.
 */
import { describe, expect, it, vi } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { twoSeedEstate } from '@/test/fixtures/traceEstates'
import { useNotificationStore } from '@/components/ui/notifications'

vi.mock('@/hooks/useCanvasTraceWalk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCanvasTraceWalk')>()),
  MAX_TRACE_SEEDS: 2,
}))

const estate = () => {
  const e = twoSeedEstate()
  return { ...e, seedModels: { orders: e.modelA, sales: e.modelB } }
}

const focusRows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-trace-focus="true"]')]
    .map(row => row.id.replace(/^layer-node-/, ''))
    .sort()

describe('a combined trace past the seed cap', () => {
  it('traces the first seeds and says how many were left out', async () => {
    useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales', 'ledger'])

    expect(useNotificationStore.getState().history.map(n => n.message))
      .toContain('Tracing the first 2 of 3 selected entities.')
    expect(focusRows()).toEqual(['orders', 'sales'])
    expect(h.dockFocus()).toBe('2 entities')
  }, 30000)
})
