/**
 * CleanupFields — a merge of near-duplicate values at scale: each click sends one change, and
 * re-renders the list once; a thousand values draw only the groups in view. A failed read of every
 * value says so, with a retry, and a property with too many values to list says it can't be
 * previewed rather than that it holds none.
 */
import { Profiler, useState } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchCatalogProperty, SearchCatalogValue } from '@/types/search'
import type { OpDraft } from '../opModel'

let allValues: SearchCatalogValue[] | null = null
let readError: string | null = null
const retry = vi.fn()
vi.mock('../useAllValues', () => ({
  useAllValues: () => ({ values: allValues, loading: false, error: readError, retry }),
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

const property = (over: Partial<SearchCatalogProperty> & { key: string }): SearchCatalogProperty => ({
  count: 0, distinct: 0, distinctExact: true, byEntityType: {}, kinds: { String: 1 }, values: [], residual: 0, ...over,
})
const draft = (patch: Partial<OpDraft>): OpDraft => ({ kind: 'mapValues', key: 'dept', to: '', value: '', onConflict: 'skip', ...patch })

beforeEach(() => {
  allValues = null
  readError = null
  retry.mockReset()
})

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

describe('CleanupFields — when values can\'t be read or listed', () => {
  it('says every value couldn\'t be read, shows the ones listed instead, and retries', async () => {
    const user = userEvent.setup()
    readError = 'timed out'
    render(<CleanupFields op={draft({})} onChange={vi.fn()} viewId="v1"
      known={property({ key: 'dept', count: 60, distinct: 3, values: departments(1) })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t read every value it holds: timed out. Only the 3 most held are shown.')
    expect(within(screen.getByRole('list', { name: 'Values to merge' })).getAllByRole('checkbox')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('a convert says so too', () => {
    readError = 'timed out'
    render(<CleanupFields op={draft({ kind: 'convert', key: 'rank', toKind: 'Integer' })} onChange={vi.fn()} viewId="v1"
      known={property({ key: 'rank', count: 5, distinct: 1, values: [{ value: '42', kind: 'String', count: 5 }] })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Only the one most held is shown.')
  })

  it('a property holding more values than are listed is too large to preview — not one holding none', () => {
    render(<CleanupFields op={draft({ kind: 'normalize', key: 'code' })} onChange={vi.fn()} viewId="v1"
      known={property({ key: 'code', count: 9000, distinct: 5000, distinctExact: false })} />)
    expect(screen.getByText(/It holds more than 5,000 values — too many to preview here/)).toBeInTheDocument()
    expect(screen.queryByText(/hold none of its values/)).toBeNull()
  })
})
