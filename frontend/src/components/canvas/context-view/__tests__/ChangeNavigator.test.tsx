/**
 * The change navigator steps through changed entities on the canvas: each step reveals the entity
 * and opens it; one the view does not hold says so, with Skip; J/K step and Esc closes.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { useChangeNavigatorStore, type NavStop } from '@/store/changeNavigatorStore'
import { ChangeNavigator } from '../ChangeNavigator'

const stops: NavStop[] = [
  { id: 'urn:a', name: 'Orders', status: 'modified', saved: false },
  { id: 'urn:b', name: 'Sales', status: 'added', saved: true },
  { id: 'urn:c', name: 'Refunds', status: 'modified', saved: true },
]
const openNodeDrawer = vi.fn()

beforeEach(() => {
  openNodeDrawer.mockReset()
  useCanvasStore.setState({ openNodeDrawer } as never)
  useChangeNavigatorStore.setState({ active: false, stops: [], index: 0 })
})

describe('ChangeNavigator', () => {
  it('reveals and opens each change it steps to', async () => {
    const reveal = vi.fn(async () => 'revealed' as const)
    render(<ChangeNavigator reveal={reveal} />)
    expect(useChangeNavigatorStore.getState().canReveal).toBe(true)
    act(() => useChangeNavigatorStore.getState().start(stops, { scope: 'all', at: 'urn:b' }))
    expect(screen.getByText('Sales')).toBeInTheDocument()
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'Change 2 of 3')).toBeInTheDocument()
    expect(reveal).toHaveBeenLastCalledWith('urn:b')
    expect(openNodeDrawer).toHaveBeenLastCalledWith('urn:b')
    fireEvent.keyDown(window, { key: 'j' })
    expect(reveal).toHaveBeenLastCalledWith('urn:c')
    fireEvent.click(screen.getByRole('button', { name: 'Previous change' }))
    fireEvent.keyDown(window, { key: 'k' })
    expect(useChangeNavigatorStore.getState().index).toBe(0)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Change navigator' })).not.toBeInTheDocument()
  })

  it('says when this view does not hold a change, and skips it', async () => {
    const reveal = vi.fn(async (id: string) => (id === 'urn:a' ? 'unavailable' as const : 'revealed' as const))
    render(<ChangeNavigator reveal={reveal} />)
    act(() => useChangeNavigatorStore.getState().start(stops, { scope: 'all' }))
    expect(await screen.findByText('Not in this view')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Skip/ }))
    await waitFor(() => expect(screen.queryByText('Not in this view')).not.toBeInTheDocument())
    expect(screen.getByText('Sales')).toBeInTheDocument()
  })

  it('leaves keys typed into a field alone', () => {
    render(<><input aria-label="field" /><ChangeNavigator reveal={async () => 'revealed'} /></>)
    act(() => useChangeNavigatorStore.getState().start(stops, { scope: 'all' }))
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'j' })
    expect(useChangeNavigatorStore.getState().index).toBe(0)
  })
})
