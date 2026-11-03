/**
 * UpdateSubsetSearchDialog — before a subset's search changes, what the change
 * does to each of its layers: what the new search adds there, and takes away.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchViewStatus } from '@/types/searchView'

const asked = vi.fn()
vi.mock('../useLayerCounts', () => ({
  useLayerCounts: (viewId: string, rules: Array<{ id: string; predicate: unknown }>, whole: boolean) => {
    asked(viewId, rules, whole)
    const counts: Record<string, number> = { 'l1::added': 120, 'l1::removed': 35, 'l2::added': 0, 'l2::removed': 0 }
    return { status: 'done', counts: new Map(rules.map((r) => [r.id, { count: counts[r.id] ?? 0, complete: true }])) }
  },
}))

import { UpdateSubsetSearchDialog } from '../UpdateSubsetSearchDialog'

const was = { kind: 'tag', values: ['pii'] }
const next = { kind: 'tag', values: ['pii', 'gdpr'] }

const STATUS = {
  definition: { v: 1, predicate: was, within: 'view', readIn: 'v-base', layout: 'inherit' },
  definitionHash: 'h1',
  status: 'ok',
  base: { viewId: 'v-base', name: 'Sales overview', available: true },
  layers: [
    { id: 'l1', name: 'Tables', entityTypes: ['table'], rest: false, excludedTypes: [] },
    { id: 'l2', name: 'Dashboards', entityTypes: ['dashboard'], rest: false, excludedTypes: [] },
  ],
  placedByType: false,
} as unknown as SearchViewStatus

function renderDialog(onUpdate = vi.fn().mockResolvedValue(undefined)) {
  const onCancel = vi.fn()
  render(<UpdateSubsetSearchDialog subsetName="PII" status={STATUS} predicate={next as never}
    countIn="v-base" onCancel={onCancel} onUpdate={onUpdate} />)
  return { onUpdate, onCancel }
}

describe('UpdateSubsetSearchDialog', () => {
  beforeEach(() => asked.mockReset())

  it('says, layer by layer, what the new search adds and takes away', () => {
    renderDialog()
    expect(screen.getByText('+120')).toBeInTheDocument()
    expect(screen.getByText('−35')).toBeInTheDocument()
    expect(screen.getByText('no change')).toBeInTheDocument()
    // Counted where the matches are looked for: what each layer holds, with one search and not the other.
    const [viewId, rules, whole] = asked.mock.calls.at(-1)!
    expect(viewId).toBe('v-base')
    expect(whole).toBe(false)
    const added = rules.find((r: { id: string }) => r.id === 'l1::added').predicate
    expect(JSON.stringify(added)).toContain('"op":"not"')
    expect(JSON.stringify(added)).toContain('gdpr')
  })

  it('updates the view, and shows why when it can’t', async () => {
    const onUpdate = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('409'), { status: 409 }))
      .mockResolvedValueOnce(undefined)
    renderDialog(onUpdate)
    fireEvent.click(screen.getByRole('button', { name: /Update the view/ }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Update the view/ }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2))
  })

  it('Cancel leaves it as it was', () => {
    const { onCancel, onUpdate } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
