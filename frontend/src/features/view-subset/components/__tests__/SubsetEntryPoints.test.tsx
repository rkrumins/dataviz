/**
 * How a subset is started and where it came from: the header entry, the
 * Explorer deep link, and the provenance line.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useBranchStore } from '@/store/branchStore'

import { useSubsetDeepLink } from '../../hooks/useSubsetDeepLink'
import { useSubsetStudioStore } from '../../model/studioStore'
import { SubsetEntryButton } from '../SubsetEntryButton'
import { SubsetProvenance } from '../SubsetProvenance'

beforeEach(() => { sessionStorage.clear() })
afterEach(() => {
  act(() => {
    useSubsetStudioStore.getState().close({ discard: true })
    useBranchStore.getState().reset()
  })
})

describe('SubsetEntryButton', () => {
  it('opens the studio on this view, and asks to leave it when open', () => {
    render(<SubsetEntryButton viewId="v1" maxHops={6} className="" />)
    const button = screen.getByRole('button', { name: 'Subset' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(button)
    expect(useSubsetStudioStore.getState().sourceViewId).toBe('v1')
    expect(useSubsetStudioStore.getState().maxHops).toBe(6)
    expect(screen.getByRole('button', { name: 'Subset' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Subset' }))
    // Nothing picked, so leaving needs no confirmation.
    expect(useSubsetStudioStore.getState().sourceViewId).toBeNull()
  })

  it('waits while a draft is open — a subset is made from the published view', () => {
    act(() => { useBranchStore.setState({ viewId: 'v1', currentBranchId: 'br_1', mainBranchId: 'br_main' }) })
    render(<SubsetEntryButton viewId="v1" className="" />)
    expect((screen.getByRole('button', { name: 'Subset' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('useSubsetDeepLink', () => {
  function withUrl(url: string) {
    let location = ''
    const Probe = () => { location = useLocation().search; return null }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[url]}>{children}<Probe /></MemoryRouter>
    )
    return { wrapper, search: () => location }
  }

  it('opens the studio once subsets are offered, then drops the parameter', () => {
    const url = withUrl('/views/v1?subset=1&tab=x')
    const { rerender } = renderHook(({ offered }) => useSubsetDeepLink('v1', offered), {
      wrapper: url.wrapper, initialProps: { offered: false },
    })
    // Not yet offered (the reader's rights are still arriving): nothing lost.
    expect(useSubsetStudioStore.getState().sourceViewId).toBeNull()
    expect(url.search()).toContain('subset=1')
    rerender({ offered: true })
    expect(useSubsetStudioStore.getState().sourceViewId).toBe('v1')
    expect(url.search()).toBe('?tab=x')
  })
})

describe('SubsetProvenance', () => {
  it('names and links a source the reader can open', () => {
    render(
      <MemoryRouter>
        <SubsetProvenance derivedFrom={{ id: 'src', name: 'Finance lineage', accessible: true }} itemClassName="" linkClassName="" />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: 'Subset of Finance lineage' })
    expect(link.getAttribute('href')).toBe('/views/src')
  })

  it('never names one they cannot', () => {
    render(
      <MemoryRouter>
        <SubsetProvenance derivedFrom={{ id: 'src', name: null, accessible: false }} itemClassName="" linkClassName="" />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText("Subset of a view you can't open")).toBeTruthy()
  })
})
