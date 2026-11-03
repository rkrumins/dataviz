/**
 * Narrow on the REAL Context View canvas: right-click an entity, narrow to it
 * and one level inside it. The canvas keeps only what the server says is in
 * scope (and the containers on the way to it), says that it is narrowed, and
 * Show everything brings the whole view back. Off, the preview offers nothing.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useNarrowStore } from '@/features/narrow/narrowStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useFeaturesStore } from '@/store/features'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import type { MembershipRequest, MembershipResult } from '@/types/membership'

const cardBody = (id: string) => {
  const card = document.getElementById(`layer-node-${id}`)
  if (!card) throw new Error(`no card ${id}`)
  return card
}

/** INTERMEDIATE_T2 and what sits directly inside it, as the server answers. */
const ONE_LEVEL_IN: MembershipResult = {
  specHash: 'h1',
  members: [{ urn: 'INTERMEDIATE_T2', via: 'seed' }, { urn: 'orders', via: 'inside' }],
  wholeSubtree: [],
  chains: { INTERMEDIATE_T2: ['snowflake'], orders: ['INTERMEDIATE_T2', 'snowflake'] },
  counts: { seeds: 1, inside: 1, upstream: 0, downstream: 0, partnerInside: 0, total: 2 },
  missingSeeds: 0,
  truncated: [],
  dataVersion: '1',
  elapsedMs: 3,
}

function setPreview(on: boolean) {
  useFeaturesStore.setState({
    values: { ...useFeaturesStore.getState().values, viewMembershipEnabled: on, traceEnabled: true },
  } as never)
}

async function open(asked: MembershipRequest[]) {
  return renderCanvasWithTrace(cfoEstate(), {
    focus: 'cfo',
    deferTrace: true,
    wrapProvider: (p) => ({
      ...p,
      resolveMembers: async (_viewId: string, request: MembershipRequest) => {
        asked.push(request)
        return ONE_LEVEL_IN
      },
    }) as GraphDataProvider,
  })
}

describe('narrowing the canvas', () => {
  afterEach(() => {
    useNarrowStore.getState().clear()
    setPreview(false)
  })

  it('right-click → Narrow to this → One level in: only that stays, and the canvas says so', async () => {
    setPreview(true)
    const asked: MembershipRequest[] = []
    const h = await open(asked)
    expect(h.visibleCardIds()).toEqual(expect.arrayContaining(['INTERMEDIATE_T2', 'REPORTING', 'tableau']))

    await act(async () => { fireEvent.contextMenu(cardBody('INTERMEDIATE_T2')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('Narrow to this…')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('One level in')) })

    await waitFor(() => expect(h.visibleCardIds()).not.toContain('REPORTING'), { timeout: 8000 })
    expect(asked[0].spec).toMatchObject({ seeds: { urns: ['INTERMEDIATE_T2'] }, expand: { children: 1, upstream: 0 } })
    expect(h.visibleCardIds()).toContain('INTERMEDIATE_T2')
    expect(h.visibleCardIds()).not.toContain('tableau')
    expect(screen.getByRole('status', { name: 'The canvas is narrowed' })).toHaveTextContent('Narrowed to 2 entities')
    // The collapsed container says what of the narrowing is inside it.
    expect(cardBody('INTERMEDIATE_T2')).toHaveTextContent('1')

    await act(async () => { fireEvent.click(screen.getByText('Show everything')) })
    await h.settle()
    expect(h.visibleCardIds()).toEqual(expect.arrayContaining(['INTERMEDIATE_T2', 'REPORTING', 'tableau']))
    expect(screen.queryByRole('status', { name: 'The canvas is narrowed' })).toBeNull()
  }, 30000)

  it('is not offered while the preview is off', async () => {
    setPreview(false)
    const h = await open([])
    await act(async () => { fireEvent.contextMenu(cardBody('INTERMEDIATE_T2')) })
    await h.settle()
    expect(screen.queryByText('Narrow to this…')).toBeNull()
  }, 30000)
})
