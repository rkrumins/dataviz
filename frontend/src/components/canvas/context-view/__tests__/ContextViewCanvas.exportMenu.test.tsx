/**
 * Right-click → "Export with children…" on the real canvas: offered on an entity's row, never on a
 * grouping row (`logical:`), which is not an entity, so there is nothing to export and the item
 * could only do nothing.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { groupAndAnchorEstate } from '@/test/fixtures/traceEstates'

const item = () => screen.queryByRole('button', { name: /Export with children/ })

async function rightClick(id: string) {
  const row = document.getElementById(`layer-node-${id}`)!
  await act(async () => { fireEvent.contextMenu(row) })
}

describe('Export with children in the context menu', () => {
  it('is offered on an entity, not on a grouping row', async () => {
    const h = await renderCanvasWithTrace(groupAndAnchorEstate(), {
      focus: 'solo', versioned: true, dataSourceId: 'harness-ds', ancestorChains: true,
    })
    await waitFor(() => expect(h.visibleCardIds()).toContain('g.a'), { timeout: 8000 })

    await rightClick('g.a')
    expect(h.contextMenuOpen()).toBe(true)
    expect(item()).toBeTruthy()
    h.pressEscape()
    await h.settle()

    await rightClick('logical:grp')
    expect(h.contextMenuOpen()).toBe(true)
    expect(item()).toBeNull()
  }, 30000)
})
