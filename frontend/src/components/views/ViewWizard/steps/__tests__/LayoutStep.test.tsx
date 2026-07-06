/**
 * LayoutStep — RTL test (Task 4: canonical view-config store).
 *
 * Template application is a client-side copy of layer STRUCTURE only — it must
 * never carry assignments into formData.assignments (a fresh create/template
 * switch always resets assignments to {}), matching the wizard's canonical
 * write path where placements live exclusively in formData.assignments.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({ entityTypes: [], isLoading: false, isError: false }),
}))

vi.mock('@/services/contextModelService', () => ({
  listTemplates: vi.fn().mockResolvedValue([]),
}))

import { LayoutStep } from '../LayoutStep'
import type { WizardFormData } from '../../ViewWizard'

const layoutTypes = [
  { id: 'graph' as const, label: 'Graph', icon: null, description: '', features: [] },
  { id: 'hierarchy' as const, label: 'Hierarchy', icon: null, description: '', features: [] },
  { id: 'reference' as const, label: 'Context View', icon: null, description: '', features: [] },
]

function makeFormData(overrides: Partial<WizardFormData> = {}): WizardFormData {
  return {
    name: 'Test view',
    description: '',
    icon: 'Layout',
    visibility: 'private',
    tags: [],
    layoutType: 'reference',
    layers: [],
    assignments: { 'urn:stale': { layerId: 'stale-layer', inheritsChildren: true } },
    visibleEntityTypes: [],
    visibleRelationshipTypes: [],
    advancedFilters: [],
    isValid: true,
    ...overrides,
  }
}

describe('LayoutStep — template application', () => {
  it('applying a Quick Start template copies layer structure but never assignments', async () => {
    const updateFormData = vi.fn()
    render(
      <LayoutStep
        formData={makeFormData()}
        updateFormData={updateFormData}
        layoutTypes={layoutTypes}
      />
    )

    // Wait for the (mocked, empty) backend template fetch to resolve so the
    // fallback gallery (LOCAL_FALLBACK_TEMPLATES) is the one rendered.
    await waitFor(() => expect(screen.getByText('Simple')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Simple'))

    expect(updateFormData).toHaveBeenCalledTimes(1)
    const call = updateFormData.mock.calls[0][0]
    expect(call.layers).toHaveLength(2)
    expect(call.layers.map((l: { name: string }) => l.name)).toEqual(['Input', 'Output'])
    expect(call.layoutTemplateId).toBe('simple')
    // A template's layers get fresh ids, so any prior assignments (keyed to the
    // OLD layer ids) are reset — never carried over, and never populated FROM
    // the template (templates don't carry assignments in the first place).
    expect(call.assignments).toEqual({})
    expect(call.layers.every((l: { entityAssignments?: unknown }) => !l.entityAssignments)).toBe(true)
  })
})
