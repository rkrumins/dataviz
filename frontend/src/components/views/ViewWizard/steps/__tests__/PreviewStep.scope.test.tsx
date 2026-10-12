/**
 * The last screen before a view exists says WHAT IT WILL CONTAIN.
 *
 * Whether a view shows everything matching its columns or only what was placed
 * by hand used to be decided silently, by an inference over whether any
 * assignment happened to exist — and that is the difference between a view that
 * keeps up with the source and one that is a snapshot. It is now stated, and
 * resolved by the very function the save uses, so the screen cannot promise one
 * thing and write another.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WizardFormData } from '../../ViewWizard'
import type { ViewLayerConfig } from '@/types/schema'

vi.mock('@/hooks/usePublishGate', () => ({ usePublishGate: () => ({ canPublish: true }) }))

import { PreviewStep } from '../PreviewStep'

const ruleLayer: ViewLayerConfig[] = [
  { id: 'l1', name: 'Domains', entityTypes: ['domain'], order: 0 },
]

function makeFormData(over: Partial<WizardFormData> = {}): WizardFormData {
  return {
    name: 'V', description: '', icon: 'Layout', visibility: 'private', tags: [],
    layoutType: 'reference', layers: ruleLayer, assignments: {},
    visibleEntityTypes: [], visibleRelationshipTypes: [], advancedFilters: [],
    isValid: true, ...over,
  }
}

describe('PreviewStep — what the view will contain', () => {
  it('says it keeps up with the source when the columns place by rule', () => {
    render(<PreviewStep formData={makeFormData()} />)
    expect(screen.getByText('Everything that matches your columns')).toBeInTheDocument()
    expect(screen.getByText(/appear on their own/)).toBeInTheDocument()
  })

  it('says it is a fixed set when entities were placed by hand', () => {
    render(<PreviewStep formData={makeFormData({
      layers: [{ id: 'l1', name: 'Mine', entityTypes: [], order: 0 }],
      assignments: {
        'urn:a': { layerId: 'l1', inheritsChildren: true },
        'urn:b': { layerId: 'l1', inheritsChildren: true },
      },
    })} />)
    expect(screen.getByText('Only the 2 entities you placed')).toBeInTheDocument()
    expect(screen.getByText(/stays out/)).toBeInTheDocument()
  })

  it('still says "everything" when a rule-driven layout also has a drag', () => {
    // The case the pin exists for: one manual placement must not turn a
    // rule-driven view into a two-entity snapshot, and the screen has to agree.
    render(<PreviewStep formData={makeFormData({
      entityScope: 'all',
      assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true } },
    })} />)
    expect(screen.getByText('Everything that matches your columns')).toBeInTheDocument()
  })

  it("reports the edited view's stored scope over the derivation", () => {
    render(<PreviewStep
      formData={makeFormData({ assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true } } })}
      viewEntityScope="all"
    />)
    expect(screen.getByText('Everything that matches your columns')).toBeInTheDocument()
  })

  it('says nothing for a layout with no columns to reason about', () => {
    render(<PreviewStep formData={makeFormData({ layoutType: 'graph', layers: [] })} />)
    expect(screen.queryByText('What it shows')).not.toBeInTheDocument()
  })
})
