/**
 * The status chips state facts to people who can't edit the view, with no
 * instructions for editing it; someone who can edit it still gets them.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CanvasStatusChips } from '../CanvasStatusChips'

const none = { unresolvedEdgeCount: 0, unassignedEntities: [], aggDetailShown: 0, aggDetailTotal: 0 }

/** Focus a chip and wait for its tooltip; the page's text, tooltip included. */
async function tipOf(chipLabel: string | RegExp, tipTitle: string | RegExp): Promise<string> {
  fireEvent.focus(screen.getByText(chipLabel).parentElement!)
  await screen.findAllByText(tipTitle)
  return document.body.textContent ?? ''
}

describe('CanvasStatusChips — lineage beyond the view', () => {
  const chip = (canEdit?: boolean) =>
    render(<CanvasStatusChips {...none} canEdit={canEdit} selectedExternal={{ in: 2, out: 3 }} />)

  it('tells a reader how to see it', async () => {
    chip()
    const text = await tipOf(/outside this view/, 'This entity has lineage beyond this view')
    expect(text).toContain('it is NOT missing data. Run a Trace to see them.')
    expect(text).not.toMatch(/Add those entities/)
  })

  it('tells an editor they can add those entities too', async () => {
    chip(true)
    const text = await tipOf(/outside this view/, 'This entity has lineage beyond this view')
    expect(text).toContain('it is NOT missing data. Add those entities to the view, or run a Trace, to see them.')
  })
})

describe('CanvasStatusChips — flows that lead outside the view', () => {
  const chip = (canEdit?: boolean) =>
    render(<CanvasStatusChips {...none} canEdit={canEdit} unresolvedEdgeCount={3} viewScope="curated" />)

  it('tells a reader it is expected', async () => {
    chip()
    const text = await tipOf('flows outside this view', '3 flows lead outside this view')
    expect(text).toContain('these flows lead to entities it leaves out. That\'s expected.')
    expect(text).not.toMatch(/add those entities/i)
  })

  it('tells an editor how to see the flows', async () => {
    chip(true)
    const text = await tipOf('flows outside this view', '3 flows lead outside this view')
    expect(text).toContain('That\'s expected; add those entities to the view to see the flows.')
  })
})

describe('CanvasStatusChips — loaded entities outside the view', () => {
  const chip = (viewScope: 'curated' | 'all', canEdit?: boolean) => {
    render(<CanvasStatusChips {...none} canEdit={canEdit} viewScope={viewScope}
      unassignedEntities={[{ id: 'e1', label: 'Alpha', type: 'Table' }]} />)
    fireEvent.click(screen.getByRole('button', { name: /^1/ }))
  }

  it.each([
    ['curated', 'Loaded but not part of this view'],
    ['all', 'Loaded but not in any layer'],
  ] as const)('tells a reader where they are, in a %s view', (viewScope, heading) => {
    chip(viewScope)
    expect(screen.getByText(heading)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/assign/i)
  })

  it.each([
    ['curated', 'Loaded but not part of this view — assign to include'],
    ['all', 'Loaded but not rendered — assign to a layer to show'],
  ] as const)('tells an editor to assign them, in a %s view', (viewScope, heading) => {
    chip(viewScope, true)
    expect(screen.getByText(heading)).toBeInTheDocument()
  })
})

describe('CanvasStatusChips — placements not found here', () => {
  const chip = (canEdit?: boolean) => {
    render(<CanvasStatusChips {...none} canEdit={canEdit}
      notFoundPlacements={[{ urn: 'urn:li:dataset:orders', label: 'orders', layerName: 'Sources' }]} />)
    fireEvent.click(screen.getByRole('button', { name: /1 placement not found here/ }))
  }

  it('tells a reader they are kept', () => {
    chip()
    expect(screen.getByText(/They’re kept, and appear as soon as the entity arrives here\./)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/edit the view/)
  })

  it('tells an editor how to remove them', () => {
    chip(true)
    expect(screen.getByText(/To remove them, edit the view and see Assignments\./)).toBeInTheDocument()
  })
})
