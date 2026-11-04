/**
 * LayerSettingsPanel — one layer in a panel of its own: the essentials, the
 * layer's own properties, and, under More, what is rarely touched. Stage keeps
 * only what changed; outside a draft it is the layer's details, read-only, with
 * the way into a draft.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { ViewLayerConfig } from '@/types/schema'

import { LayerSettingsPanel } from '../LayerSettingsPanel'

const LAYER: ViewLayerConfig = {
  id: 'l1', name: 'Staging', description: 'Cleaned feeds', color: '#6366f1', icon: 'Layers',
  entityTypes: ['dataset'], order: 1, properties: { owner: 'data-eng' },
}

describe('LayerSettingsPanel', () => {
  it('stages only the fields that changed', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<LayerSettingsPanel layer={LAYER} canEdit onSave={onSave} onClose={onClose} />)
    const stage = screen.getByRole('button', { name: 'Stage changes' })
    expect(stage).toBeDisabled()

    const name = screen.getByRole('textbox', { name: 'Layer name' })
    await user.clear(name)
    await user.type(name, 'Cleansed')
    await user.click(stage)
    expect(onSave).toHaveBeenCalledWith({ name: 'Cleansed' })
    expect(onClose).toHaveBeenCalled()
  })

  it('never undoes an edit made elsewhere while it was open', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const { rerender } = render(<LayerSettingsPanel layer={LAYER} canEdit onSave={onSave} onClose={vi.fn()} />)
    // Renamed in the column's header meanwhile.
    rerender(<LayerSettingsPanel layer={{ ...LAYER, name: 'Renamed' }} canEdit onSave={onSave} onClose={vi.fn()} />)
    await user.type(screen.getByRole('textbox', { name: 'Layer description' }), ' daily')
    await user.click(screen.getByRole('button', { name: 'Stage changes' }))
    expect(onSave).toHaveBeenCalledWith({ description: 'Cleaned feeds daily' })
  })

  it('adds a property of the layer\'s own', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    render(<LayerSettingsPanel layer={{ ...LAYER, properties: undefined }} canEdit onSave={onSave} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Add first property/ }))
    await user.type(screen.getByPlaceholderText('Property name'), 'sla')
    await user.type(screen.getByPlaceholderText('Enter a value…'), '4h')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('button', { name: 'Stage changes' }))
    expect(onSave).toHaveBeenCalledWith({ properties: { sla: '4h' } })
  })

  it('keeps what is rarely touched under More — delete among it', async () => {
    const user = userEvent.setup()
    const onDelete = vi.fn()
    render(<LayerSettingsPanel layer={LAYER} canEdit onSave={vi.fn()} onDelete={onDelete} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Delete layer' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'More' }))
    await user.click(screen.getByRole('button', { name: 'Delete layer' }))
    expect(onDelete).toHaveBeenCalled()
  })

  it('outside a draft, shows the layer\'s details and the way into a draft', async () => {
    const user = userEvent.setup()
    const onStartEditing = vi.fn()
    render(<LayerSettingsPanel layer={LAYER} canEdit={false} onSave={vi.fn()} onStartEditing={onStartEditing} onClose={vi.fn()} />)
    expect(screen.getByText('Layer details')).toBeInTheDocument()
    expect(screen.getByText('Cleaned feeds')).toBeInTheDocument()
    expect(screen.getByText('data-eng')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stage changes' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Start editing' }))
    expect(onStartEditing).toHaveBeenCalled()
  })
})
