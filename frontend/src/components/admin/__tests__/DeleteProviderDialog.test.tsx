/**
 * The delete dialog lists the versioned graphs projected into the provider, by key, with the
 * rest of its impact.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DeleteProviderDialog } from '../DeleteProviderDialog'
import type { ProviderResponse } from '@/services/providerService'

const PROVIDER = { id: 'prov_1', name: 'graph' } as unknown as ProviderResponse

describe('DeleteProviderDialog', () => {
  it('lists the versioned graphs projected into the provider', () => {
    render(
      <DeleteProviderDialog
        provider={PROVIDER}
        impact={{
          catalogItems: [], workspaces: [], views: [],
          versionedGraphs: [{ id: 'g1', name: 'customer360', type: 'versioned_graph' }],
        }}
        loadingImpact={false}
        isOpen
        onClose={() => undefined}
        onConfirm={() => undefined}
      />,
    )
    expect(screen.queryByText(/safe to delete/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /1 versioned graph$/i }))
    expect(screen.getByText('customer360')).toBeTruthy()
  })
})
