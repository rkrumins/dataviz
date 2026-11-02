/**
 * ForkStrip — on a fork's own pages (its Versioning tab, the canvas of its views): what it was forked
 * from, as a link to that data source; how far it is from it; and Update from parent (publishers)
 * and Propose to parent. While forks are off it says so and offers neither, and still reads. On a
 * data source that is no fork it renders nothing, and reads nothing to find that out.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let forksOn = true
let canPublish = true
let sources: Array<Record<string, unknown>> | undefined
let forks: Array<Record<string, unknown>> | undefined
const useDataSourcesWithForks = vi.fn((..._args: unknown[]) => ({ data: sources }))
const useForks = vi.fn((_ws?: string, gid?: string | null) => ({ data: gid === 'g1' ? forks : undefined }))

vi.mock('@/store/features', () => ({ useFeature: (key: string) => (key === 'forksEnabled' ? forksOn : true) }))
vi.mock('@/store/auth', () => ({ usePermission: (p: string) => (p.endsWith(':publish') ? canPublish : true) }))
vi.mock('../../hooks/useVersioning', () => ({
  useDataSourcesWithForks: (...args: unknown[]) => useDataSourcesWithForks(...args),
  useForks: (ws?: string, gid?: string | null) => useForks(ws, gid),
}))
vi.mock('../UpdateFromParentButton', () => ({
  UpdateFromParentButton: ({ forkGraphId }: { forkGraphId: string }) =>
    <button data-fork={forkGraphId}>Update from parent</button>,
}))
vi.mock('../ProposeToParentButton', () => ({
  ProposeToParentButton: ({ forkGraphId, parentDataSourceId, behind }: {
    forkGraphId: string; parentDataSourceId: string; behind: number
  }) => <button data-fork={forkGraphId} data-parent={parentDataSourceId} data-behind={behind}>Propose to parent</button>,
}))

import { ForkStrip } from '../ForkStrip'

const strip = (dataSourceId: string, variant: 'tab' | 'bar' = 'tab') => render(
  <MemoryRouter><ForkStrip wsId="ws1" dataSourceId={dataSourceId} variant={variant} /></MemoryRouter>,
)

beforeEach(() => {
  forksOn = true
  canPublish = true
  sources = [
    { id: 'ds1', label: 'Sales', forkOf: null },
    { id: 'dsfork_1', label: 'Sales · Q3', forkOf: { dataSourceId: 'ds1', graphId: 'g1' } },
  ]
  forks = [{
    graphId: 'g_f', dataSourceId: 'dsfork_1', label: 'Sales · Q3', ahead: 4, behind: 2,
    updateRecommended: false, readsFrom: 'overlay', countsCapped: false, purging: false,
  }]
  useDataSourcesWithForks.mockClear()
})

describe('ForkStrip', () => {
  it('says what a fork was forked from, as a link to it, and how far it is from it', () => {
    strip('dsfork_1')
    expect(screen.getByText(/Fork of/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sales' })).toHaveAttribute('href', '/workspaces/ws1?ds=ds1&dstab=versioning')
    expect(screen.getByText('4 ahead · 2 behind')).toBeInTheDocument()
  })

  it('offers Update from parent to a publisher, and Propose to parent to anyone', () => {
    strip('dsfork_1', 'bar')
    expect(screen.getByRole('button', { name: 'Update from parent' })).toHaveAttribute('data-fork', 'g_f')
    const propose = screen.getByRole('button', { name: 'Propose to parent' })
    expect(propose).toHaveAttribute('data-fork', 'g_f')
    expect(propose).toHaveAttribute('data-parent', 'ds1')
    expect(propose).toHaveAttribute('data-behind', '2')
  })

  it('offers no Update from parent without the publish permission', () => {
    canPublish = false
    strip('dsfork_1')
    expect(screen.queryByRole('button', { name: 'Update from parent' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Propose to parent' })).toBeInTheDocument()
  })

  it('says when an update from parent is recommended', () => {
    forks = [{ ...forks![0], updateRecommended: true }]
    strip('dsfork_1')
    expect(screen.getByText(/Update recommended/)).toBeInTheDocument()
  })

  it('says forks are turned off, offers neither action, and still reads', () => {
    forksOn = false
    strip('dsfork_1')
    expect(screen.getByText(/Forks are turned off for this deployment/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update from parent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Propose to parent' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Sales' })).toBeInTheDocument()
    expect(screen.getByText('4 ahead · 2 behind')).toBeInTheDocument()
  })

  it('renders nothing on a data source that is no fork, and reads nothing to know it', () => {
    const { container } = strip('ds1')
    expect(container).toBeEmptyDOMElement()
    expect(useDataSourcesWithForks).not.toHaveBeenCalled()
  })

  it('renders nothing when the data source says it was forked from nothing', () => {
    sources = [{ id: 'dsfork_1', label: 'Odd', forkOf: null }]
    const { container } = strip('dsfork_1')
    expect(container).toBeEmptyDOMElement()
  })
})
