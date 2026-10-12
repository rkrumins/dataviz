/**
 * A new view from a file starts from the file's details; once one is changed, the file's value is a
 * click away again, for each of them.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { WizardFormData } from '../../ViewWizard'

vi.mock('@/services/viewApiService', () => ({ listViews: vi.fn(async () => ({ items: [] })) }))

import { ImportMetadataPanel } from '../ImportMetadataPanel'

const FILE = { name: 'Finance lineage', description: 'What feeds revenue', icon: 'Layout', tags: ['finance'], viewType: 'reference' }

function renderPanel(form: Partial<WizardFormData>) {
  const updateFormData = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ImportMetadataPanel formData={{ ...FILE, ...form } as WizardFormData} updateFormData={updateFormData}
        file={FILE} environment="dev" workspaceId="ws1" />
    </QueryClientProvider>,
  )
  return updateFormData
}

describe('ImportMetadataPanel — a new view', () => {
  it('offers the file’s value back for each detail that was changed', () => {
    const update = renderPanel({ description: 'Mine now', tags: [] })
    expect(screen.queryByRole('button', { name: 'icon' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'description' }))
    expect(update).toHaveBeenLastCalledWith({ description: 'What feeds revenue' })
    fireEvent.click(screen.getByRole('button', { name: 'tags' }))
    expect(update).toHaveBeenLastCalledWith({ tags: ['finance'] })
  })

  it('says nothing when nothing was changed', () => {
    renderPanel({})
    expect(screen.queryByText(/Changed from the file/)).not.toBeInTheDocument()
  })
})
