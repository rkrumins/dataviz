/**
 * OrphansDrawer — the Context View's orphaned-entities panel (Display → Advanced).
 *
 * It asks the server for orphans only while open, pages them by the server's cursor, says
 * where each one is in this view (drawn, placed but not loaded, or nowhere), and hands Reveal
 * and Place in layer back to the canvas.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GraphDataProvider, GraphNode, TopLevelNodesResult } from '@/providers/GraphDataProvider'
import type { ViewLayerConfig } from '@/types/schema'
import { OrphansDrawer, type OrphanWhere, type OrphansDrawerProps } from '../OrphansDrawer'

const node = (urn: string, displayName = urn, entityType = 'Table'): GraphNode =>
  ({ urn, displayName, entityType, properties: {} }) as GraphNode

const page = (nodes: GraphNode[], extra: Partial<TopLevelNodesResult> = {}): TopLevelNodesResult => ({
  nodes, totalCount: nodes.length, hasMore: false, nextCursor: null, rootTypeCount: 0, orphanCount: nodes.length, ...extra,
})

const layers: ViewLayerConfig[] = [
  { id: 'L1', name: 'Domains', order: 0, entityTypes: [], color: '#ff0000' },
  { id: 'L2', name: 'Tables', order: 1, entityTypes: [] },
]

function providerWith(getTopLevelNodes: (...args: unknown[]) => Promise<TopLevelNodesResult>) {
  return { getTopLevelNodes: vi.fn(getTopLevelNodes) } as unknown as GraphDataProvider & {
    getTopLevelNodes: ReturnType<typeof vi.fn>
  }
}

function renderDrawer(overrides: Partial<OrphansDrawerProps> = {}) {
  const props: OrphansDrawerProps = {
    open: true,
    onClose: vi.fn(),
    provider: providerWith(async () => page([])),
    layers,
    layerOf: () => ({ drawn: false }),
    onReveal: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<OrphansDrawer {...props} />) }
}

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement

describe('OrphansDrawer', () => {
  it('asks for nothing while closed', async () => {
    const provider = providerWith(async () => page([]))
    renderDrawer({ open: false, provider })
    await act(async () => {})
    expect(provider.getTopLevelNodes).not.toHaveBeenCalled()
  })

  it('opened, asks once for the first page of orphans only', async () => {
    const provider = providerWith(async () => page([node('urn:a', 'Alpha')]))
    renderDrawer({ provider })
    await screen.findByText('Alpha')
    expect(provider.getTopLevelNodes).toHaveBeenCalledTimes(1)
    expect(provider.getTopLevelNodes).toHaveBeenCalledWith({
      orphansOnly: true, limit: 50, cursor: null, includeChildCount: true,
    })
    expect(screen.getByText('1 with no parent in the data')).toBeInTheDocument()
  })

  it('says where each one is: drawn, placed but not loaded, or not in this view', async () => {
    const where: Record<string, OrphanWhere> = {
      'urn:a': { layerId: 'L1', drawn: true },
      'urn:b': { layerId: 'L2', drawn: false },
      'urn:c': { drawn: false },
    }
    renderDrawer({
      provider: providerWith(async () => page([node('urn:a', 'Alpha'), node('urn:b', 'Beta'), node('urn:c', 'Gamma')])),
      layerOf: (n) => where[n.urn],
    })
    await screen.findByText('Alpha')
    expect(within(rowOf('Alpha')).getByText('Domains')).toBeInTheDocument()
    expect(within(rowOf('Beta')).getByText('Tables · not loaded')).toBeInTheDocument()
    expect(within(rowOf('Gamma')).getByText('Not in this view')).toBeInTheDocument()
  })

  it('Reveal is off for an entity this view does not place, and reveals the rest', async () => {
    const onReveal = vi.fn()
    renderDrawer({
      provider: providerWith(async () => page([node('urn:a', 'Alpha'), node('urn:c', 'Gamma')])),
      layerOf: (n) => (n.urn === 'urn:a' ? { layerId: 'L2', drawn: false } : { drawn: false }),
      onReveal,
    })
    await screen.findByText('Alpha')
    const gamma = screen.getByRole('button', { name: 'Reveal Gamma on the canvas' })
    expect(gamma).toBeDisabled()
    fireEvent.click(gamma)
    fireEvent.click(screen.getByRole('button', { name: 'Reveal Alpha on the canvas' }))
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onReveal).toHaveBeenCalledWith('urn:a')
  })

  it('offers Place in layer only when the canvas allows it', async () => {
    const first = renderDrawer({ provider: providerWith(async () => page([node('urn:a', 'Alpha')])) })
    await screen.findByText('Alpha')
    expect(screen.queryByRole('combobox', { name: 'Place Alpha in a layer' })).toBeNull()
    first.unmount()

    const onPlace = vi.fn()
    renderDrawer({ provider: providerWith(async () => page([node('urn:a', 'Alpha')])), onPlace })
    await screen.findByText('Alpha')
    fireEvent.change(screen.getByRole('combobox', { name: 'Place Alpha in a layer' }), { target: { value: 'L2' } })
    expect(onPlace).toHaveBeenCalledWith('urn:a', 'L2')
  })

  it('Load more sends the server\'s cursor and appends, without reloading the first page', async () => {
    const provider = providerWith(async (...args: unknown[]) => {
      const q = args[0] as { cursor: string | null }
      return q.cursor === null
        ? page([node('urn:a', 'Alpha')], { totalCount: 2, hasMore: true, nextCursor: 'cur-1' })
        : page([node('urn:a', 'Alpha'), node('urn:b', 'Beta')], { totalCount: 2 })
    })
    renderDrawer({ provider })
    await screen.findByText('Alpha')
    expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Beta')
    expect(provider.getTopLevelNodes).toHaveBeenCalledTimes(2)
    expect(provider.getTopLevelNodes).toHaveBeenLastCalledWith({
      orphansOnly: true, limit: 50, cursor: 'cur-1', includeChildCount: true,
    })
    // De-duplicated by URN, and nothing more to load.
    expect(screen.getAllByText('Alpha')).toHaveLength(1)
    expect(screen.getByText('Showing 2 of 2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('says Many when the server could not count them and more pages remain', async () => {
    renderDrawer({ provider: providerWith(async () => page([node('urn:a', 'Alpha')], { totalCount: null, hasMore: true, nextCursor: 'c' })) })
    await screen.findByText('Alpha')
    expect(screen.getByText('Many with no parent in the data')).toBeInTheDocument()
    expect(screen.getByText('Showing 1 of Many')).toBeInTheDocument()
  })

  it('says so when there are none', async () => {
    renderDrawer()
    expect(await screen.findByText(/No orphaned entities/)).toBeInTheDocument()
  })

  it('a failed load offers Retry, which asks again', async () => {
    let fail = true
    const provider = providerWith(async () => {
      if (fail) throw new Error('boom')
      return page([node('urn:a', 'Alpha')])
    })
    renderDrawer({ provider })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Couldn't load orphaned entities")
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    await screen.findByText('Alpha')
    expect(provider.getTopLevelNodes).toHaveBeenCalledTimes(2)
  })

  it('a reply for a provider it no longer reads is dropped', async () => {
    let answerOld: (r: TopLevelNodesResult) => void = () => {}
    const oldProvider = providerWith(() => new Promise<TopLevelNodesResult>((resolve) => { answerOld = resolve }))
    const newProvider = providerWith(async () => page([node('urn:new', 'Fresh')]))
    const { props, rerender } = renderDrawer({ provider: oldProvider })
    await waitFor(() => expect(oldProvider.getTopLevelNodes).toHaveBeenCalledTimes(1))

    rerender(<OrphansDrawer {...props} provider={newProvider} />)
    await screen.findByText('Fresh')
    await act(async () => { answerOld(page([node('urn:old', 'Stale')])) })
    expect(screen.queryByText('Stale')).toBeNull()
    expect(screen.getByText('Fresh')).toBeInTheDocument()
  })

  it('closes from its button and from Escape', async () => {
    const { props } = renderDrawer()
    await screen.findByText(/No orphaned entities/)
    fireEvent.click(screen.getByRole('button', { name: 'Close orphaned entities' }))
    fireEvent.keyDown(screen.getByText(/No orphaned entities/), { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })
})
