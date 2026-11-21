/**
 * CleanupFields — a merge of near-duplicate values at scale: each click sends one change, and
 * re-renders the list once; a thousand values draw only the groups in view.
 */
import { Profiler, useState } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchCatalogValue } from '@/types/search'
import type { OpDraft } from '../opModel'

let allValues: SearchCatalogValue[] | null = null
vi.mock('../useAllValues', () => ({
  useAllValues: () => ({ values: allValues, loading: false, error: null }),
}))

import { CleanupFields } from '../CleanupFields'

/** `n` groups of three spellings of one department: "Dept 7", "dept 7 ", "DEPT 7". */
function departments(n: number): SearchCatalogValue[] {
  return Array.from({ length: n }, (_, i) => [
    { value: `Dept ${i}`, kind: 'String', count: 30 },
    { value: `dept ${i} `, kind: 'String', count: 20 },
    { value: `DEPT ${i}`, kind: 'String', count: 10 },
  ]).flat()
}

/** The What step's fields under a parent that keeps the op, as the dialog does. */
function Harness({ onChange, onRender }: { onChange: (patch: Partial<OpDraft>) => void; onRender: () => void }) {
  const [op, setOp] = useState<OpDraft>({ kind: 'mapValues', key: 'dept', to: '', value: '', onConflict: 'skip' })
  return (
    <Profiler id="cleanup" onRender={onRender}>
      <CleanupFields op={op} viewId="v1" known={null}
        onChange={(patch) => { onChange(patch); setOp((o) => ({ ...o, ...patch })) }} />
    </Profiler>
  )
}

beforeEach(() => { allValues = null })

describe('CleanupFields — merging values', () => {
  it('sends one change per click, and draws the list once for it', async () => {
    const user = userEvent.setup()
    allValues = departments(3)
    const onChange = vi.fn()
    const renders = { n: 0 }
    render(<Harness onChange={onChange} onRender={() => { renders.n++ }} />)
    // The suggestions it opens with are the merge, until one is chosen.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].map).toHaveLength(6)

    onChange.mockClear()
    renders.n = 0
    const groups = within(screen.getByRole('list', { name: 'Values to merge' }))
    await user.click(groups.getAllByRole('checkbox')[0]!)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].map).toHaveLength(4)
    expect(renders.n).toBe(1)

    onChange.mockClear()
    renders.n = 0
    await user.click(groups.getByRole('radio', { name: 'Keep “DEPT 1”' }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0].map).toContainEqual({ from: 'Dept 1', fromKind: 'String', to: 'DEPT 1', toKind: 'String' })
    expect(renders.n).toBe(1)
  })

  it('draws only the groups in view of a thousand values', () => {
    // jsdom lays nothing out: the list scrolls in a box a few groups tall.
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 288 })
    try {
      allValues = departments(334)
      const t = performance.now()
      render(<Harness onChange={vi.fn()} onRender={() => {}} />)
      act(() => {})
      expect(performance.now() - t).toBeLessThan(2000)
      const rows = within(screen.getByRole('list', { name: 'Values to merge' })).getAllByRole('listitem')
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThan(30)
      expect(screen.getByText(/Merges/)).toHaveTextContent('Merges 668 values into another')
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })
})
