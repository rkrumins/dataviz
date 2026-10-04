/**
 * BuildPanel — flag-on, it hands the canvas's contract type map to the Grid and the Paste preview,
 * so their Layer cells agree with where Apply puts a row. Grid and Paste are reduced to the prop.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

const seen = vi.hoisted(() => ({ grid: undefined as unknown, paste: undefined as unknown }))
vi.mock('../BuildGrid', () => ({
  BuildGrid: (p: { contractTypeLayerMap?: unknown }) => { seen.grid = p.contractTypeLayerMap; return null },
}))
vi.mock('../BuildPaste', () => ({
  BuildPaste: (p: { contractTypeLayerMap?: unknown }) => { seen.paste = p.contractTypeLayerMap; return null },
}))

import { BuildPanel } from '../BuildPanel'

describe('BuildPanel', () => {
  it('hands contractTypeLayerMap to the Grid and the Paste preview', () => {
    const map = new Map([['dataset', 'b']])
    render(<BuildPanel onClose={() => {}} contractTypeLayerMap={map} />)
    fireEvent.click(screen.getByRole('tab', { name: /Grid/ }))
    expect(seen.grid).toBe(map)
    fireEvent.click(screen.getByRole('tab', { name: /Paste/ }))
    expect(seen.paste).toBe(map)
  })
})
