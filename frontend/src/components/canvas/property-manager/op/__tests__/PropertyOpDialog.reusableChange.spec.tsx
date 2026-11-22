/**
 * PropertyOpDialog, opened with a reusable change: every part of the operation as it was kept, and
 * where it reaches, searched where it was — then checked again here before it is applied.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/versioningApiService')>()),
  previewPropertyJob: vi.fn(async () => ({ refusal: null, nameBudget: null, activeJobId: null, counts: null })),
  previewPropertyJobSample: vi.fn(async () => ({ rows: [], truncated: false })),
  createPropertyJob: vi.fn(),
}))
vi.mock('@/hooks/usePropertyCatalog', () => ({
  usePropertyCatalog: () => ({
    catalog: {
      properties: [
        { key: 'dept', count: 300, kinds: { String: 300 }, byEntityType: {}, distinct: 2, distinctExact: true, residual: 0, values: [
          { value: 'Finance', kind: 'String', count: 200 }, { value: 'fin', kind: 'String', count: 100 }] },
      ],
    },
  }),
}))
vi.mock('../useAllValues', () => ({ useAllValues: () => ({ values: null, loading: false, error: null }) }))
vi.mock('../../../search/builder/useDiscovery', () => ({ useDiscovery: () => ({ keysByEdgeType: {} }) }))
vi.mock('../useReviewCounts', () => ({
  useReviewCounts: () => ({ counts: new Map(), complete: false, percent: 0, error: null, unavailable: false }),
}))

import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useViewLibraryStore } from '@/store/viewLibraryStore'
import type { OpRequest } from '@/store/propertyJobsStore'
import { PropertyOpDialog } from '../PropertyOpDialog'

function open(seed: OpRequest) {
  render(
    <PropertyOpDialog viewId="v1" graphWrite={{ wsId: 'ws', graphId: 'g1', branchId: 'd1' }} seed={seed} knownEntityTypes={['Table']}
      layers={[{ id: 'L1', name: 'Gold' }]} selectionIds={[]} onClose={vi.fn()} />,
  )
}
const next = () => screen.getByRole('button', { name: /^Next/ })

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [] } as never)
})

describe('PropertyOpDialog seeded with a whole change', () => {
  it('opens a whole change on Where, searched where it was kept — the whole data source still has to be meant', async () => {
    const user = userEvent.setup()
    open({ op: { kind: 'set', key: 'tier', value: 'gold', onConflict: 'skip' }, target: { kind: 'view' }, scopeMode: 'data_source' })
    expect(screen.getByRole('radio', { name: /Every entity in the view/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'The whole data source' })).toHaveAttribute('aria-checked', 'true')
    expect(next()).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'I mean the whole data source' }))
    expect(next()).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('combobox', { name: 'Property' })).toHaveValue('tier')
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue('gold')
  })

  it('names the reusable change it runs, and offers to keep it for reuse only once it is changed', async () => {
    const user = userEvent.setup()
    useViewLibraryStore.setState({ viewId: 'v1', branchId: null, status: 'ready', canEdit: true, reusableChanges: [] })
    open({ op: { kind: 'set', key: 'tier', value: 'gold', onConflict: 'skip' }, target: { kind: 'view' }, scopeMode: 'view', reusable: { name: 'Gold tier' } })
    expect(screen.getByText(/^From reusable change:/)).toHaveTextContent('From reusable change: Gold tier')
    await user.click(next())
    expect(screen.queryByRole('button', { name: /Save for reuse/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Where/ }))
    await user.click(screen.getByRole('radio', { name: /Every entity with tier/ }))
    await user.click(next())
    expect(screen.getByRole('button', { name: /Save for reuse/ })).toBeInTheDocument()
  })

  it('opens a clean-up on What with every part of it as it was kept', () => {
    open({
      op: { kind: 'replace', key: 'dept', find: 'fin', replaceWith: 'Finance', matchCase: true, wholeValue: true, onConflict: 'skip' },
      target: { kind: 'hasKey', key: 'dept' },
    })
    expect(screen.getByRole('textbox', { name: 'Find' })).toHaveValue('fin')
    expect(screen.getByRole('textbox', { name: 'Replace with' })).toHaveValue('Finance')
    expect(screen.getByRole('checkbox', { name: /Match case/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Whole value only/ })).toBeChecked()
  })
})
