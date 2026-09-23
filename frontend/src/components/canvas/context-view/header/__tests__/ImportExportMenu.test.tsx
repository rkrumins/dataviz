/**
 * ImportExportMenu — "This view": the view itself moves between environments from the canvas, as
 * a file or with its data, and can be updated from a file. Each item follows its admin switch
 * (a view with its data needs both the view and the graph export switches), and updating needs
 * the host to allow it (someone who may edit the view). The whole section is a preview behind
 * its own switch.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let features: Record<string, boolean> = {}
vi.mock('@/store/features', () => ({ useFeature: (key: string) => features[key] ?? false }))

import { ImportExportMenu } from '../ImportExportMenu'

const ALL_ON = {
  versioningEnabled: true, graphExportEnabled: true,
  viewPortabilityEnabled: true, viewExportEnabled: true, viewImportEnabled: true,
}

function open(props: Partial<React.ComponentProps<typeof ImportExportMenu>> = {}) {
  render(<ImportExportMenu isDraft={false} onExport={vi.fn()} {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Import / Export' }))
}

describe('ImportExportMenu — This view', () => {
  beforeEach(() => { features = { ...ALL_ON } })

  it('exports the view, with or without its data, and updates it from a file', () => {
    const thisView = { onExport: vi.fn(), onExportWithData: vi.fn(), onUpdateFromFile: vi.fn() }
    open({ thisView })

    expect(screen.getByRole('group', { name: 'This view' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Export view \+ data…/ }))
    expect(thisView.onExportWithData).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Import / Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Update this view from a file…/ }))
    expect(thisView.onUpdateFromFile).toHaveBeenCalledTimes(1)
  })

  it('follows the switches, and offers updating only where the host allows it', () => {
    features = { ...ALL_ON, graphExportEnabled: false, viewImportEnabled: true }
    open({ thisView: { onExport: vi.fn(), onExportWithData: vi.fn() } })

    expect(screen.getByRole('menuitem', { name: /^Export view…/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Export view \+ data/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /Update this view/ })).not.toBeInTheDocument()
  })

  it('has no view section when every view switch is off', () => {
    features = { ...ALL_ON, viewExportEnabled: false, viewImportEnabled: false }
    open({ thisView: { onExport: vi.fn(), onExportWithData: vi.fn(), onUpdateFromFile: vi.fn() } })
    expect(screen.queryByRole('group', { name: 'This view' })).not.toBeInTheDocument()
  })

  it('has no view section while the preview is off, whatever the other switches say', () => {
    features = { ...ALL_ON, viewPortabilityEnabled: false }
    open({ thisView: { onExport: vi.fn(), onExportWithData: vi.fn(), onUpdateFromFile: vi.fn() } })
    expect(screen.queryByRole('group', { name: 'This view' })).not.toBeInTheDocument()
    // The graph's own export is not part of the preview.
    expect(screen.getByRole('menuitem', { name: /^Export…/ })).toBeInTheDocument()
  })
})
