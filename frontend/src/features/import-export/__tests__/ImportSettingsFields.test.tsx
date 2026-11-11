/**
 * ImportSettingsFields pins:
 *   - each setting shows the graph's own value, or the platform's, named;
 *   - a workspace admin matches by a property (once it is named), changes a limit as a percentage,
 *     or goes back to the platform's, and only what changed is sent;
 *   - anyone else, and anyone on a fork (whose settings are its parent's), reads them;
 *   - the properties imports match by are listed with how far each index is caught up, and a guard
 *     the platform turned off says so.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ImportSettings } from '@/services/importExportApiService'
import { ImportSettingsFields } from '../ImportSettingsFields'

const values = { identifier: 'entity_id', replaceMinLive: 1000, replaceDeleteFraction: 0.5,
  replaceCreateFraction: 0.5, replaceMinMatchFraction: 0.05 }
const none = { identifier: null, replaceMinLive: null, replaceDeleteFraction: null,
  replaceCreateFraction: null, replaceMinMatchFraction: null }

function settings(over: Partial<ImportSettings> = {}): ImportSettings {
  return {
    dataSourceId: 'ds1', overrides: none, platform: values,
    effective: { ...values, sources: { identifier: 'platform', replaceMinLive: 'platform',
      replaceDeleteFraction: 'platform', replaceCreateFraction: 'platform', replaceMinMatchFraction: 'platform' } },
    replaceGuard: true, followsParent: false, matchingProperties: [], maxMatchingProperties: 10, ...over,
  }
}

describe('ImportSettingsFields', () => {
  it('names the platform’s value where the graph sets none', () => {
    render(<ImportSettingsFields settings={settings()} canEdit onSave={vi.fn()} />)
    expect(screen.getByLabelText('Match existing items by')).toHaveValue('inherit')
    expect(screen.getByRole('option', { name: 'Platform default (Entity ID)' })).toBeInTheDocument()
    expect(screen.getByLabelText(/judges a scope of at least/)).toHaveAttribute('placeholder', '1,000 (platform)')
    expect(screen.getByLabelText(/deletes at least/)).toHaveAttribute('placeholder', '50 (platform)')
  })

  it('shows the graph’s own values', () => {
    render(<ImportSettingsFields canEdit onSave={vi.fn()} settings={settings({
      overrides: { ...none, identifier: 'prop.sap_id', replaceDeleteFraction: 0.8 } })} />)
    expect(screen.getByLabelText('Match existing items by')).toHaveValue('prop')
    expect(screen.getByLabelText('Property name')).toHaveValue('sap_id')
    expect(screen.getByLabelText(/deletes at least/)).toHaveValue(80)
  })

  it('sends only what an admin changed, a property once it is named, and a percentage as a share', async () => {
    const onSave = vi.fn().mockResolvedValue({})
    render(<ImportSettingsFields settings={settings({ overrides: { ...none, replaceMinLive: 5000 } })}
      canEdit onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Match existing items by'), { target: { value: 'prop' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByText('Name the property.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'external_id' } })
    fireEvent.change(screen.getByLabelText(/deletes at least/), { target: { value: '80' } })
    fireEvent.change(screen.getByLabelText(/judges a scope of at least/), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      identifier: 'prop.external_id', replaceDeleteFraction: 0.8, replaceMinLive: 'inherit' }))
  })

  it('is read-only to someone who isn’t a workspace admin, and on a fork', () => {
    const { rerender } = render(<ImportSettingsFields settings={settings()} canEdit={false} onSave={vi.fn()} />)
    expect(screen.getByLabelText('Match existing items by')).toBeDisabled()
    expect(screen.getByText('Only a workspace admin can change these.')).toBeInTheDocument()
    rerender(<ImportSettingsFields settings={settings({ followsParent: true })} canEdit onSave={vi.fn()} />)
    expect(screen.getByLabelText(/deletes at least/)).toBeDisabled()
    expect(screen.getByText(/A fork’s import settings are its parent’s/)).toBeInTheDocument()
  })

  it('lists the properties imports match by, and says when the platform turned the guard off', () => {
    render(<ImportSettingsFields canEdit onSave={vi.fn()} settings={settings({
      replaceGuard: false, matchingProperties: [
        { name: 'external_id', status: 'ready', seq: 9, current: true, createdAt: 't' },
        { name: 'sap_id', status: 'ready', seq: 3, current: false, createdAt: 't' },
        { name: 'erp_key', status: 'building', seq: 0, current: false, createdAt: 't' },
      ] })} />)
    expect(screen.getByText('· 3 of 10', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Up to date')).toBeInTheDocument()
    expect(screen.getByText('Catches up on the next import')).toBeInTheDocument()
    expect(screen.getByText('Indexing…')).toBeInTheDocument()
    expect(screen.getByText(/The replace guard is off on this platform/)).toBeInTheDocument()
  })
})
